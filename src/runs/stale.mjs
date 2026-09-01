import fs from "node:fs";
import path from "node:path";
import { runsPath } from "../paths.mjs";
import { tmuxSessionExists } from "./tmux.mjs";

/** Statuses after which a run is finished and cannot be stuck. */
const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** Default age past which a quiet run is worth a human's attention. */
export const DEFAULT_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/**
 * Runs that are not finished and are not going anywhere.
 *
 * This deliberately does not decide anything. `gc` reaps only active runs with
 * a live terminal; every other shape — a protected `waiting_human`, a
 * `handing_off` whose worker died, a `starting` that never got a session — is
 * skipped forever by design, because bounding those means deciding when a
 * person is not coming back. That is a judgement to report, not to automate:
 * seven runs had accumulated here, one of them a `waiting_human` that had been
 * asking whether a session was still alive for 31 days.
 *
 * A run is reported when it is unfinished and either its terminal is gone or
 * its mailbox has been silent past the threshold. `reasons` says which, so the
 * report can be read without opening anything.
 */
export function findStaleRuns({
  env = process.env,
  now = Date.now(),
  thresholdMs = DEFAULT_THRESHOLD_MS,
  sessionAlive = tmuxSessionExists,
  root = null,
} = {}) {
  const dir = root ?? runsPath(env);
  if (!fs.existsSync(dir)) return [];
  const stale = [];

  for (const runId of fs.readdirSync(dir).sort()) {
    const statePath = path.join(dir, runId, "STATE.json");
    let state;
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      // No readable state is not a stuck run, it is a directory that is not a
      // run. Reporting those would bury the ones that matter.
      continue;
    }
    if (TERMINAL.has(state.status)) continue;

    const session = state.worker?.tmux ?? null;
    const alive = session ? sessionAlive(session) : false;

    let heartbeatMs = null;
    try {
      heartbeatMs = fs.statSync(path.join(dir, runId, "mailbox", "HEARTBEAT")).mtimeMs;
    } catch {
      heartbeatMs = null;
    }
    const silentMs = heartbeatMs === null ? null : now - heartbeatMs;

    const reasons = [];
    if (!session) reasons.push("never got a terminal");
    else if (!alive) reasons.push("terminal is gone");
    if (heartbeatMs === null) reasons.push("no heartbeat was ever written");
    else if (silentMs > thresholdMs) reasons.push("mailbox silent");

    if (!reasons.length) continue;

    stale.push({
      runId,
      status: state.status ?? null,
      session,
      session_alive: alive,
      silent_hours: silentMs === null ? null : Math.round((silentMs / 3_600_000) * 10) / 10,
      age_hours: ageHours(statePath, now),
      reasons,
    });
  }
  return stale;
}

function ageHours(statePath, now) {
  try {
    const ms = now - fs.statSync(statePath).mtimeMs;
    return Math.round((ms / 3_600_000) * 10) / 10;
  } catch {
    return null;
  }
}

/**
 * Worker terminals with no run pointing at them.
 *
 * A session outliving its run is the other half of the same problem: the run
 * record says finished, the terminal is still sitting there.
 */
export function findOrphanSessions({
  env = process.env,
  listSessions,
  root = null,
} = {}) {
  const dir = root ?? runsPath(env);
  const claimed = new Set();
  if (fs.existsSync(dir)) {
    for (const runId of fs.readdirSync(dir)) {
      try {
        const state = JSON.parse(
          fs.readFileSync(path.join(dir, runId, "STATE.json"), "utf8")
        );
        if (TERMINAL.has(state.status)) continue;
        if (state.worker?.tmux) claimed.add(state.worker.tmux);
      } catch {
        // unreadable state claims nothing
      }
    }
  }
  return (listSessions() ?? [])
    .filter((name) => name.startsWith("team-up-"))
    .filter((name) => !claimed.has(name));
}
