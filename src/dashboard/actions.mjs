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
import { cancelRun, loadState, mailboxDir, markCollected, setOutcome, setStatus, writeAnswer } from "../runs/runs.mjs";
import { isValidRunId } from "./data.mjs";
import { answeredAfterQuestion, inboxItem } from "./action-center.mjs";
import { readSpenderLedger } from "./run-project.mjs";

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

/**
 * Retry of a problem — a run the observer stopped on something technical (a
 * TUI prompt, a stall, a judge failure) and the usage-spender parked. There is
 * nothing to decide, so the retry is an answer that says so, and the spender
 * resumes the task in a fresh run in the next spawn window. A live run is not
 * retried (see inboxItem): its worker would never read this, and the dashboard
 * presses no keys.
 */
export const RETRY_ANSWER = "Retry: the stop was a technical problem in the worker's terminal (a prompt or a stall), "
  + "not a decision for the human, so there is nothing to choose. Continue the task from where it stopped.";

const RUN_ACTIONS = {
  cancel: (id) => cancelRun(id),
  collect: (id) => markCollected(id, { note: "collected in the dashboard" }),
  merged: (id) => recordOutcome(id, "merged"),
  discarded: (id) => recordOutcome(id, "discarded"),
  retry: (id) => writeAnswer(id, RETRY_ANSWER, { source: "human (dashboard retry)" }),
  fail: (id, reason) => {
    const why = String(reason || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
    if (!why) throw new Error("a failed run needs a reason — the insights job counts failures by it");
    return setStatus(id, "failed", { reason: why });
  },
  // The worker reads ANSWER.md; the run goes back to being watched.
  answer: (id, reason) => {
    const text = String(reason || "").trim();
    if (!text) throw new Error("an answer needs text");
    return writeAnswer(id, text.slice(0, 16_000), { source: "human (dashboard)" });
  },
};
export const RUN_ACTION_NAMES = Object.keys(RUN_ACTIONS);

/** Kept or thrown away, the result has been read: it leaves the Inbox too. An intake's own collected note stays. */
function recordOutcome(id, value) {
  if (!setOutcome(id, value, { note: "dashboard" }).collected) markCollected(id, { note: `dashboard: ${value}` });
}

export function runAction(runId, action, { reason, env = process.env } = {}) {
  if (!isValidRunId(runId)) throw new Error("invalid run id");
  if (!Object.hasOwn(RUN_ACTIONS, action)) throw new Error(`unknown action: ${action}`);
  const state = loadState(runId);
  if (!state) throw new Error(`unknown run ${runId}`);
  const terminal = ["done", "failed", "cancelled"].includes(state.status);
  if ((action === "cancel" || action === "fail") && terminal) throw new Error(`run is already ${state.status}`);
  // An outcome on a running run would half-apply: recorded, but not collectable.
  if ((action === "merged" || action === "discarded") && !terminal) throw new Error(`run is still ${state.status}`);
  if (action === "answer" || action === "retry") {
    const file = (name) => {
      try {
        const p = path.join(mailboxDir(runId), name);
        return { text: fs.readFileSync(p, "utf8"), mtimeMs: fs.statSync(p).mtimeMs };
      } catch {
        return null;
      }
    };
    const questions = file("QUESTIONS.md");
    // A second send would resume a parked run twice or overwrite the first answer.
    if (answeredAfterQuestion(questions, file("ANSWER.md"))) {
      throw Object.assign(new Error("already answered"), { httpStatus: 409 });
    }
    // waiting_decision is a capacity park: an answer would knock it out of its wait.
    if (state.status !== "waiting_human") throw new Error(`run is no longer waiting (${state.status})`);
    if (action === "retry") {
      // The Inbox's own rule, so the button and the action never disagree.
      const item = inboxItem(state, { read: (id, name) => file(name), ledger: readSpenderLedger(env) });
      if (item?.kind !== "problem") throw new Error("only a technical problem can be retried; a question needs an answer");
      if (!item.retryable) {
        throw new Error("only a run the usage-spender parked can be retried, never one stopped on a credential or billing prompt: cancel it instead");
      }
    }
  }
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
