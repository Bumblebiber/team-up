// One-click versions of the CLI commands a human otherwise types after an
// alert: mark a model limited (or lift the mark), lift the post-restart worker
// cap, close out a run, rescan what the CLIs offer. Each validates against the
// roster or the run store before it writes anything.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadJson } from "../roster/config.mjs";
import { usagePath, usageWritePath, teamUpHome } from "../paths.mjs";
import { markLimited } from "../roster/chain.mjs";
import { atomicWriteJson } from "../json-store.mjs";
import { resetCap } from "../admission/admission.mjs";
import { cancelRun, loadState, markCollected, setOutcome, setStatus } from "../runs/runs.mjs";
import { isValidRunId } from "./data.mjs";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/team-up.mjs");

/** What `mark-limited` accepts: a roster model, a model's provider, or a CLI. */
export function markTargets(roster) {
  const targets = new Set(Object.keys(roster?.models || {}));
  for (const spec of Object.values(roster?.models || {})) if (typeof spec?.provider === "string") targets.add(spec.provider);
  for (const cli of Object.keys(roster?.clis || {})) targets.add(cli);
  return [...targets].sort();
}

export function markLimitedAction({ target, hours, reason } = {}, { roster, env = process.env, now = Date.now() } = {}) {
  if (!markTargets(roster).includes(target)) throw new Error(`unknown model, provider or CLI: ${target}`);
  if (typeof hours !== "number" || !(hours >= 0.25 && hours <= 24 * 14)) throw new Error("hours: 0.25 to 336");
  const note = typeof reason === "string" ? reason.replace(/[\r\n]+/g, " ").trim().slice(0, 200) : "";
  const usage = markLimited({
    usage: loadJson(usagePath(env)), target, ttlMs: hours * 3_600_000, now, reason: note || "marked in the dashboard",
  });
  atomicWriteJson(usageWritePath(env), usage);
  return { until: usage.marked[target].until };
}

export function clearMarkAction({ target } = {}, { env = process.env } = {}) {
  const usage = loadJson(usagePath(env)) || {};
  if (!usage.marked || !Object.hasOwn(usage.marked, String(target))) throw new Error(`${target} is not marked`);
  delete usage.marked[target];
  atomicWriteJson(usageWritePath(env), usage);
  return {};
}

export function admissionResetAction({ env = process.env } = {}) {
  return { lifted: resetCap({ env }) };
}

const RUN_ACTIONS = {
  cancel: (id) => cancelRun(id),
  collect: (id) => markCollected(id, { note: "collected in the dashboard" }),
  merged: (id) => setOutcome(id, "merged", { note: "dashboard" }),
  discarded: (id) => setOutcome(id, "discarded", { note: "dashboard" }),
  fail: (id, reason) => {
    const why = String(reason || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
    if (!why) throw new Error("a failed run needs a reason — the insights job counts failures by it");
    return setStatus(id, "failed", { reason: why });
  },
};
export const RUN_ACTION_NAMES = Object.keys(RUN_ACTIONS);

export function runAction(runId, action, { reason } = {}) {
  if (!isValidRunId(runId)) throw new Error("invalid run id");
  if (!Object.hasOwn(RUN_ACTIONS, action)) throw new Error(`unknown action: ${action}`);
  const state = loadState(runId);
  if (!state) throw new Error(`unknown run ${runId}`);
  const terminal = ["done", "failed", "cancelled"].includes(state.status);
  if ((action === "cancel" || action === "fail") && terminal) throw new Error(`run is already ${state.status}`);
  RUN_ACTIONS[action](runId, reason);
  return { status: loadState(runId)?.status ?? null };
}

/** `team-up models scan` in the background; the Roster tab shows the result once it lands. */
export function startModelsScan({ env = process.env, spawnFn = spawn } = {}) {
  const log = path.join(teamUpHome(env), "logs", "models-scan.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, "w");
  const child = spawnFn(process.execPath, [BIN, "models", "scan"], { detached: true, stdio: ["ignore", out, out], env });
  child.unref();
  fs.closeSync(out);
  return { started: true, log };
}
