#!/usr/bin/env node
// usage-watchdog.mjs — read-only minutely check of usage + watcher state.
// Prints nothing when healthy; short report otherwise. Exit 0 always.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadJson, configPath } from "../src/roster/config.mjs";
import { limits } from "../src/roster/chain.mjs";
import { usagePath, usageWatcherStatePath } from "../src/paths.mjs";
import { effectiveResetAt, resolveHandoffAt } from "../src/usage/usage-windows.mjs";
import { watcherConfig, DEFAULT_CONFIG, intervalMinForCli } from "../src/usage/usage-watcher.mjs";

const STALL_MARGIN_MS = 5 * 60_000;
const JUMP_THRESHOLD = 0.15;
const FAILURE_REPEAT = 3;
const AUTH_FAILURE_REASONS = new Set(["auth_failure"]);
const MARK_EXPIRED_GRACE_MS = 24 * 60 * 60_000;
const TELEGRAM_MAX = 3500;

function parseIso(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function dueIntervalMs(watcherState, cli, cfg = DEFAULT_CONFIG) {
  const state = watcherState?.state || "idle";
  return intervalMinForCli(cli, state, cfg) * 60_000;
}

/**
 * Pure detectors — each returns issue strings (empty = ok).
 */
export function detectStalledCollectors({ usage, watcher, now = Date.now(), cfg = DEFAULT_CONFIG }) {
  const issues = [];
  const subs = ["claude", "codex", "cursor"];
  for (const cli of subs) {
    if (watcher?.collecting?.[cli]) continue;
    const due = parseIso(watcher?.next_due?.[cli]);
    if (due === null) continue;
    const overdue = now - due;
    if (overdue < STALL_MARGIN_MS) continue;
    let newest = 0;
    const prefix = `${cli}:`;
    for (const [k, v] of Object.entries(usage?.windows || {})) {
      if (!k.startsWith(prefix)) continue;
      const t = parseIso(v?.updated_at || v?.updated);
      if (t !== null) newest = Math.max(newest, t);
    }
    const lastCollect = parseIso(watcher?.last_collect?.[cli]);
    const reference = Math.max(newest, lastCollect ?? 0);
    if (reference > 0 && now - reference > dueIntervalMs(watcher, cli, cfg) + STALL_MARGIN_MS) {
      issues.push(`${cli} collector stalled (${Math.round(overdue / 60_000)}m overdue)`);
    }
  }
  return issues;
}

export function detectExpiredHighUsage({ usage, roster, now = Date.now() }) {
  const thresholds = limits(roster || {});
  const issues = [];
  for (const [wkey, info] of Object.entries(usage?.windows || {})) {
    if (typeof info?.used !== "number") continue;
    if (info.used < resolveHandoffAt(wkey, thresholds)) continue;
    const resetAt = effectiveResetAt(info, wkey, thresholds, now);
    if (resetAt !== null && now >= resetAt) {
      issues.push(`${wkey} still at ${Math.round(info.used * 100)}% after reset passed`);
    }
  }
  return issues;
}

export function detectUnexplainedUsageJumps({ usage }) {
  const issues = [];
  for (const [wkey, info] of Object.entries(usage?.windows || {})) {
    const history = Array.isArray(info?.history) ? info.history : [];
    if (history.length < 2) continue;
    const prev = history[history.length - 2];
    const last = history[history.length - 1];
    if (typeof prev?.used !== "number" || typeof last?.used !== "number") continue;
    const delta = last.used - prev.used;
    if (Math.abs(delta) < JUMP_THRESHOLD) continue;
    if (delta < 0 && last.used < 0.05) continue; // dropped to empty — quota reset
    issues.push(
      `${wkey} moved ${Math.round(prev.used * 100)}% → ${Math.round(last.used * 100)}% without reset`,
    );
  }
  return issues;
}

export function detectCollectFailures({ watcher }) {
  const issues = [];
  for (const [cli, entries] of Object.entries(watcher?.collect_failures || {})) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    for (const entry of entries) {
      if (AUTH_FAILURE_REASONS.has(entry.reason)) {
        issues.push(`${cli} auth/login failure`);
      }
    }
    if (entries.length < FAILURE_REPEAT) continue;
    const recent = entries.slice(-FAILURE_REPEAT);
    const sameReason = recent.every((e) => e.reason === recent[0].reason);
    if (sameReason) {
      issues.push(`${cli} collect failed ${FAILURE_REPEAT}x: ${recent[0].reason}`);
    }
  }
  return issues;
}

export function detectMarkedEntries({ usage, now = Date.now() }) {
  const issues = [];
  for (const [target, mark] of Object.entries(usage?.marked || {})) {
    const until = parseIso(mark?.until);
    if (until === null) continue;
    if (until <= now && now - until > MARK_EXPIRED_GRACE_MS) {
      issues.push(`marked ${target} expired ${mark.until}`);
    }
  }
  return issues;
}

export function runWatchdog({
  usage,
  watcher,
  roster,
  now = Date.now(),
  cfg = DEFAULT_CONFIG,
} = {}) {
  const issues = [
    ...detectStalledCollectors({ usage, watcher, now, cfg }),
    ...detectExpiredHighUsage({ usage, roster, now }),
    ...detectUnexplainedUsageJumps({ usage }),
    ...detectCollectFailures({ watcher }),
    ...detectMarkedEntries({ usage, now }),
  ];
  return { ok: issues.length === 0, issues };
}

function loadDoc(path, fallback = null) {
  try {
    return loadJson(path) ?? fallback;
  } catch {
    return fallback;
  }
}

function main() {
  const jsonOut = process.argv.includes("--json");
  const usage = loadDoc(usagePath());
  const watcher = loadDoc(usageWatcherStatePath());
  const roster = loadDoc(configPath());
  const cfg = watcherConfig(roster || {});
  const result = runWatchdog({ usage, watcher, roster, cfg });
  if (result.ok) return;
  const payload = { at: new Date().toISOString(), issues: result.issues };
  const text = jsonOut
    ? JSON.stringify(payload)
    : `team-up usage-watchdog (${result.issues.length}):\n${result.issues.map((i) => `- ${i}`).join("\n")}`;
  const clipped = text.length > TELEGRAM_MAX ? `${text.slice(0, TELEGRAM_MAX - 3)}...` : text;
  console.log(clipped);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
