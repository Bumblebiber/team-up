// usage-watcher.mjs — adaptive process watcher → usage-collect triggers.

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { configPath, loadJson } from "../roster/roster.mjs";
import {
  countAgentProcesses,
  countAgentProcessesOptsFromEnv,
  killCollectStrays,
  watcherStatePath,
} from "./usage-procs.mjs";
import { subscriptionsFromRoster } from "./usage-collect.mjs";

const DEFAULT_CONFIG = {
  tick_sec: 60,
  // idle_min keeps sampling while no local agent runs: the burn a second
  // machine puts on the same account is invisible to the process count and
  // only shows up as a rising window. It must stay under the 45min the burn
  // rate reaches back, or an idle CLI never has two samples to draw a line
  // through. ponytail: one codex collect measures 143s wall / 59MB, but the
  // TUI itself boots in ~4s — the rest is `expect eof` waiting out its timeout
  // on a codex that never closes the PTY. Fix that and the idle cadence gets
  // much cheaper; until then this is ~2.5min per PTY-based CLI per interval.
  intervals: { idle_heartbeat_hours: 24, idle_min: 30, active_min: 20, busy_min: 8 },
};

export function watcherConfig(roster) {
  return { ...DEFAULT_CONFIG, ...(roster?.usage_watcher || {}) };
}

/**
 * Sleep between watcher ticks. Cap at 60s while supervised runs exist.
 */
export function watcherSleepSec(cfg, { supervisedCount = 0 } = {}) {
  const tick = Number(cfg?.tick_sec) > 0 ? Number(cfg.tick_sec) : DEFAULT_CONFIG.tick_sec;
  if (supervisedCount > 0) return Math.min(tick, 60);
  return tick;
}

export function computeState(counts) {
  const sum = counts.claude + counts.codex + counts.cursor;
  if (sum === 0) return "idle";
  if (sum >= 2 || counts.claude > 1 || counts.codex > 1 || counts.cursor > 1) return "busy";
  return "active";
}

function parseIso(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Pure: which CLIs to collect this tick (does not advance schedule).
 * @returns {{ collect: string[], state: string }}
 */
export function planCollect({
  counts,
  prevCounts,
  state,
  collecting,
  lastCollect,
  nextDue,
  now = Date.now(),
  subscriptions = ["claude", "codex", "cursor"],
}) {
  const collect = new Set();

  for (const cli of subscriptions) {
    if (collecting?.[cli]) continue;
    const prev = prevCounts[cli] ?? 0;
    const cur = counts[cli] ?? 0;
    if (prev === 0 && cur > 0) collect.add(cli);
    if (prev > 0 && cur === 0) collect.add(cli);
  }

  // No process-count gate: an idle CLI still samples on its (slower) due date,
  // otherwise a trend only ever exists for CLIs busy on this machine.
  for (const cli of subscriptions) {
    if (collecting?.[cli]) continue;
    const due = parseIso(nextDue[cli]);
    if (due === null || now >= due) collect.add(cli);
  }

  const hbMs = DEFAULT_CONFIG.intervals.idle_heartbeat_hours * 3_600_000;
  for (const cli of subscriptions) {
    if (collecting?.[cli]) continue;
    // A CLI that has never collected successfully has no last_collect, so the
    // heartbeat alone would re-fire it every tick forever. An attempt already
    // on the schedule is enough.
    const due = parseIso(nextDue[cli]);
    if (due !== null && now < due) continue;
    const t = parseIso(lastCollect[cli]);
    if (t === null || now - t >= hbMs) collect.add(cli);
  }

  return { collect: [...collect], state };
}

/** @deprecated alias */
export function decideCollect(opts) {
  const plan = planCollect(opts);
  const advanced = advanceSchedule({
    successful: plan.collect,
    state: plan.state,
    lastCollect: opts.lastCollect || {},
    nextDue: opts.nextDue || {},
    now: opts.now,
    config: opts.config || DEFAULT_CONFIG,
  });
  return { ...plan, next: advanced };
}

/**
 * Journal a collect round. `next_due` moves for every CLI that was *tried* —
 * without that, a CLI whose collect keeps failing is re-picked on every 60s
 * tick and hogs the PTY lock. `last_collect` moves only on success, so the
 * 24h heartbeat still notices a CLI that has produced nothing.
 */
export function advanceSchedule({
  successful,
  attempted = successful,
  state,
  lastCollect,
  nextDue,
  now = Date.now(),
  config = DEFAULT_CONFIG,
}) {
  const intervalMin =
    state === "busy"
      ? config.intervals.busy_min
      : state === "idle"
        ? (config.intervals.idle_min ?? DEFAULT_CONFIG.intervals.idle_min)
        : config.intervals.active_min;
  const next = {
    last_collect: { ...lastCollect },
    next_due: { ...nextDue },
  };

  for (const cli of attempted) {
    next.next_due[cli] = new Date(now + intervalMin * 60_000).toISOString();
  }
  for (const cli of successful) {
    next.last_collect[cli] = new Date(now).toISOString();
  }

  return next;
}

function loadState() {
  let doc = null;
  try {
    doc = loadJson(watcherStatePath());
  } catch (e) {
    // A kill mid-write used to leave 0 bytes here, and JSON.parse("") then
    // threw on every tick until someone stopped the service. Start over.
    console.error(`watcher state unreadable, starting fresh: ${e.message || e}`);
  }
  return (
    doc || {
      counts: { claude: 0, codex: 0, cursor: 0 },
      prev_counts: { claude: 0, codex: 0, cursor: 0 },
      state: "idle",
      collecting: { claude: false, codex: false, cursor: false },
      last_collect: { claude: null, codex: null, cursor: null },
      next_due: { claude: null, codex: null, cursor: null },
    }
  );
}

/**
 * A collect never spans ticks — the loop in tickOnce is synchronous — so a
 * `collecting` flag found at startup belongs to a process that is gone, and
 * planCollect would skip that CLI for good. (Cross-process overlap is the PTY
 * lock's job, not this flag's.) Clearing them is what makes a restart mid
 * collect recoverable instead of silently disabling a subscription.
 */
export function clearCollecting(state) {
  const collecting = {};
  for (const cli of Object.keys(state?.collecting || {})) collecting[cli] = false;
  return { ...state, collecting };
}

function saveState(state) {
  const dest = watcherStatePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, dest);
}

/**
 * Per-CLI ceiling for one collect. claude answers a plain `-p /usage`; codex
 * and cursor each have to boot a full terminal UI first, and cursor was capped
 * at the claude figure — every cursor collect died on ETIMEDOUT mid-boot, so
 * its windows had not been updated in days.
 */
const COLLECT_TIMEOUT_MS = { claude: 120_000, codex: 300_000, cursor: 300_000 };

function runCollect(cli) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "usage-collect.mjs");
  try {
    execFileSync(process.execPath, [script, "--cli", cli], {
      stdio: "inherit",
      timeout: COLLECT_TIMEOUT_MS[cli] ?? 120_000,
    });
  } catch (e) {
    // Timeout only. There the child takes a SIGTERM and dies without running
    // its own finally, so the CLI and its MCP servers leak into this service's
    // cgroup, and the watcher is the only survivor that can sweep them. Any
    // other exit already swept under the PTY lock — or never held it, and a
    // sweep would kill the collect that does (a Stop hook's, say, which exits
    // nonzero here as pty-lock-contention).
    if (e?.code === "ETIMEDOUT") {
      const killed = killCollectStrays();
      if (killed.length) console.error(`swept ${killed.length} leftover ${cli} collect process(es)`);
    }
    throw e;
  }
}

export function tickOnce({ roster, now = Date.now(), dryRun = false } = {}) {
  const cfg = watcherConfig(roster || {});
  const subs = subscriptionsFromRoster(roster || {});
  const stateDoc = loadState();
  const counts = countAgentProcesses(countAgentProcessesOptsFromEnv());
  const state = computeState(counts);

  const plan = planCollect({
    counts,
    prevCounts: stateDoc.prev_counts || stateDoc.counts,
    state,
    collecting: stateDoc.collecting,
    lastCollect: stateDoc.last_collect || {},
    nextDue: stateDoc.next_due || {},
    now,
    subscriptions: subs,
  });

  const toCollect = [...new Set(plan.collect)].filter((c) => subs.includes(c));
  const successful = [];

  if (!dryRun) {
    for (const cli of toCollect) {
      stateDoc.collecting = { ...stateDoc.collecting, [cli]: true };
      saveState(stateDoc);
      try {
        runCollect(cli);
        successful.push(cli);
      } catch (e) {
        console.error(`collect failed ${cli}:`, e.message || e);
      } finally {
        stateDoc.collecting = { ...stateDoc.collecting, [cli]: false };
      }
    }
    const advanced = advanceSchedule({
      successful,
      attempted: toCollect,
      state,
      lastCollect: stateDoc.last_collect || {},
      nextDue: stateDoc.next_due || {},
      now,
      config: cfg,
    });
    stateDoc.counts = counts;
    stateDoc.prev_counts = stateDoc.counts;
    stateDoc.state = state;
    stateDoc.last_collect = advanced.last_collect;
    stateDoc.next_due = advanced.next_due;
    saveState(stateDoc);
  }

  return { counts, state, collect: toCollect, successful };
}

/**
 * After a successful usage collection, supervise specialist runs.
 * Caps collection interval at 60s while supervised runs exist (caller).
 */
export async function afterUsageCollectSupervise({ now = new Date().toISOString(), deps } = {}) {
  if (deps) {
    const { superviseActiveRuns } = await import("../supervisor/controller.mjs");
    return superviseActiveRuns({ now, deps });
  }
  const { superviseProductionRuns } = await import("../supervisor/production.mjs");
  return superviseProductionRuns({ now });
}

async function main() {
  const once = process.argv.includes("--once");
  const dryRun = process.argv.includes("--dry-run");
  const roster = loadJson(configPath()) || {};
  const cfg = watcherConfig(roster);

  if (!dryRun) saveState(clearCollecting(loadState()));

  if (once) {
    const r = tickOnce({ roster, dryRun });
    console.log(`state=${r.state} counts=${JSON.stringify(r.counts)} collect=${r.collect.join(",") || "(none)"}`);
    if (!dryRun) {
      try {
        const results = await afterUsageCollectSupervise({
          now: new Date().toISOString(),
        });
        if (results?.length) {
          console.log(`supervised: ${results.map((x) => `${x.runId}:${x.decision.action}`).join(",")}`);
        }
      } catch (e) {
        console.error("supervise error:", e.message || e);
      }
    }
    return;
  }

  console.log(`team-up usage-watcher tick=${cfg.tick_sec}s`);
  for (;;) {
    let supervisedCount = 0;
    try {
      const r = tickOnce({ roster });
      if (r.collect.length) console.log(`collected: ${r.successful.join(", ") || "(none ok)"}`);
      try {
        const results = await afterUsageCollectSupervise({
          now: new Date().toISOString(),
        });
        supervisedCount = Array.isArray(results) ? results.length : 0;
        if (results?.length) {
          console.log(`supervised: ${results.map((x) => `${x.runId}:${x.decision.action}`).join(",")}`);
        }
      } catch (e) {
        console.error("supervise error:", e.message || e);
      }
      // Prefer live supervised-run count from production listing when available.
      try {
        const { listSupervisedRuns } = await import("../supervisor/production.mjs");
        supervisedCount = Math.max(
          supervisedCount,
          listSupervisedRuns({ now: new Date().toISOString() }).length
        );
      } catch {
        // ignore
      }
    } catch (e) {
      console.error("watcher tick error:", e.message || e);
    }
    const sleepSec = watcherSleepSec(cfg, { supervisedCount });
    await new Promise((res) => setTimeout(res, sleepSec * 1000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
