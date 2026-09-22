#!/usr/bin/env node
// Summarize shadow/control triage outcomes from run STATE.json files only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runsPath } from "../src/paths.mjs";

const TIERS = ["low", "medium", "high", "frontier"];

export function loadRunStates(root = runsPath()) {
  if (!fs.existsSync(root)) return [];
  const states = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      states.push(JSON.parse(fs.readFileSync(path.join(root, entry.name, "STATE.json"), "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  return states;
}

function cohort() {
  return { runs: 0, done: 0, failed: 0, escalated: 0 };
}

function observeOutcome(target, state) {
  target.runs++;
  if (state.status === "done") target.done++;
  if (state.status === "failed") target.failed++;
  if (state.status === "waiting_human" || state.escalations?.length) target.escalated++;
}

export function buildTriageShadowReport(states) {
  const roles = {};
  for (const state of states) {
    const decision = state?.triage;
    if (!decision || decision.applied === true) continue;
    const role = state.role || "unknown";
    const row = roles[role] ??= {
      runs: 0,
      jev: 0,
      fallback: 0,
      wouldDowngrade: 0,
      wouldUpgrade: 0,
      sameTier: 0,
      unknownWorkerTier: 0,
      highTier: cohort(),
      lowerTier: cohort(),
    };
    row.runs++;
    if (decision.source !== "jev" || !decision.profile?.tier) {
      row.fallback++;
      continue;
    }
    row.jev++;
    const proposed = TIERS.indexOf(decision.profile.tier);
    const actual = TIERS.indexOf(state.worker?.tier);
    if (proposed < 0) {
      row.unknownWorkerTier++;
      continue;
    }
    if (actual < 0) row.unknownWorkerTier++;
    else if (proposed < actual) row.wouldDowngrade++;
    else if (proposed > actual) row.wouldUpgrade++;
    else row.sameTier++;
    observeOutcome(proposed >= 2 ? row.highTier : row.lowerTier, state);
  }
  return {
    roles,
    notes: [
      "Counts include shadow runs and active-mode control runs; applied triage runs are excluded.",
      "Failure is status=failed. Escalation is a recorded handoff/pass-to event or status=waiting_human.",
      "Legacy runs without worker.tier cannot contribute to downgrade/upgrade counts.",
    ],
  };
}

function printReport(report) {
  for (const [role, row] of Object.entries(report.roles).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`${role}: ${row.runs} runs, ${row.jev} Jev, ${row.fallback} fallback`);
    console.log(`  would downgrade ${row.wouldDowngrade}, upgrade ${row.wouldUpgrade}, same ${row.sameTier}, unknown worker tier ${row.unknownWorkerTier}`);
    for (const [label, bucket] of [["high/frontier", row.highTier], ["low/medium", row.lowerTier]]) {
      console.log(`  ${label}: ${bucket.runs} runs, ${bucket.done} done, ${bucket.failed} failed, ${bucket.escalated} escalated`);
    }
  }
  for (const note of report.notes) console.log(`note: ${note}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf("--runs-dir");
  const root = dirIndex >= 0 ? args[dirIndex + 1] : runsPath();
  if (!root || args.some((arg, i) => arg !== "--json" && arg !== "--runs-dir" && !(dirIndex >= 0 && i === dirIndex + 1))) {
    console.error("usage: node scripts/triage-shadow-report.mjs [--runs-dir <dir>] [--json]");
    process.exitCode = 1;
  } else {
    const report = buildTriageShadowReport(loadRunStates(root));
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
  }
}
