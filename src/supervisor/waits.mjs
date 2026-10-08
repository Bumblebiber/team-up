import fs from "node:fs";
import path from "node:path";
import { loadState, updateState, runDir, setStatus } from "../runs/runs.mjs";
import { runsPath } from "../paths.mjs";

// Beside the runs directory. Through runsPath, so TEAM_UP_HOME is honoured:
// resolving HOME here put a test's waits into the real ~/.team-up.
function waitsIndexPath(env = process.env) {
  return path.join(path.dirname(runsPath(env)), "capacity-waits.json");
}

function loadWaits(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(waitsIndexPath(env), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { waits: {} };
    throw e;
  }
}

function saveWaits(data, env = process.env) {
  const p = waitsIndexPath(env);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

export const RESOURCE_RETRY_MS = 2 * 60 * 1000;

/**
 * Park a run until the machine has room. `action` is replayed once admitted;
 * without one, a specialist launch starts from its durable launch descriptor.
 */
export function deferForResources({
  runId,
  admission,
  verdict = null,
  action = null,
  now = new Date(),
  env = process.env,
}) {
  const at = now instanceof Date ? now : new Date(now);
  const resumeAt = new Date(at.getTime() + RESOURCE_RETRY_MS).toISOString();
  const statusFile = path.join(runDir(runId), "mailbox", "STATUS");
  let mailboxStatus = null;
  try {
    mailboxStatus = fs.readFileSync(statusFile, "utf8").trim() || null;
  } catch {
    // no mailbox status yet: a launch parked before its first start
  }
  let capacity = null;
  updateState(runId, (state) => {
    capacity = {
      reason: "resources",
      auto_resume: true,
      resume_not_before: resumeAt,
      admission: { reason: admission?.reason ?? null, verdict },
      resume_action: action,
      // A run that asked its human a question returns to that state.
      resume_status: state.status === "waiting_capacity" ? state.capacity?.resume_status ?? "watching" : state.status,
      // Restore worker-owned STATUS after the run leaves the parked state.
      resume_mailbox_status: state.status === "waiting_capacity" ? state.capacity?.resume_mailbox_status ?? null : mailboxStatus,
      wait_cancelled: false,
      available_actions: ["cancel"],
      approved_at: at.toISOString(),
    };
    state.status = "waiting_capacity";
    state.capacity = capacity;
    return state;
  });
  setStatus(runId, "waiting_capacity");
  const waits = loadWaits(env);
  waits.waits[runId] = {
    runId,
    resume_not_before: resumeAt,
    auto_resume: true,
    approved_at: at.toISOString(),
    reason: "resources",
  };
  saveWaits(waits, env);
  return capacity;
}

function postponeResourceWait(runId, admission, now, env) {
  const resumeAt = new Date(Date.parse(now) + RESOURCE_RETRY_MS).toISOString();
  updateState(runId, (state) => {
    state.capacity = {
      ...(state.capacity || {}),
      resume_not_before: resumeAt,
      admission: { ...(state.capacity?.admission || {}), reason: admission.reason },
      last_recheck_at: now,
    };
    return state;
  });
  const waits = loadWaits(env);
  if (waits.waits[runId]) {
    waits.waits[runId].resume_not_before = resumeAt;
    saveWaits(waits, env);
  }
  return resumeAt;
}

function finishResourceWait(runId, status, now, env, mailboxOverride = null) {
  let mailboxStatus = null;
  updateState(runId, (state) => {
    mailboxStatus = state.capacity?.resume_mailbox_status ?? null;
    state.status = status;
    state.capacity = { ...(state.capacity || {}), auto_resume: false, resumed_at: now, last_recheck_at: now };
    return state;
  });
  const statusFile = path.join(runDir(runId), "mailbox", "STATUS");
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(statusFile, `${mailboxOverride ?? mailboxStatus ?? status}\n`);
  const waits = loadWaits(env);
  delete waits.waits[runId];
  saveWaits(waits, env);
}

export function listDueWaits({ now = new Date().toISOString(), env = process.env, reason = null } = {}) {
  const nowMs = Date.parse(now);
  const waits = loadWaits(env);
  const due = [];
  for (const [runId, w] of Object.entries(waits.waits || {})) {
    if (!w.auto_resume || w.cancelled) continue;
    if (reason && w.reason !== reason) continue;
    const t = Date.parse(w.resume_not_before);
    if (Number.isFinite(t) && nowMs >= t) due.push(runId);
  }
  return due;
}

/** Resume due resource waits after admission, starting at most one worker per pass. */
export async function resumeDueWaits({
  now = new Date().toISOString(),
  env = process.env,
  startWorker,
  admit = null,
  executeAction = null,
} = {}) {
  const due = listDueWaits({ now, env, reason: "resources" });
  const results = [];
  let resourceStarted = false;
  for (const runId of due) {
    const state = loadState(runId);
    if (
      !state?.capacity?.auto_resume ||
      state.capacity?.wait_cancelled ||
      state.capacity?.reason !== "resources"
    ) {
      continue;
    }
    if (resourceStarted) {
      results.push({ runId, ok: true, resumed: false, reason: "one_start_per_pass" });
      continue;
    }
    if (typeof admit === "function") {
      const decision = await admit(state);
      if (!decision.ok) {
        const next = postponeResourceWait(runId, decision, now, env);
        results.push({ runId, ok: true, resumed: false, reason: `admission: ${decision.reason}`, resume_not_before: next });
        continue;
      }
    }

    const action = state.capacity.resume_action;
    try {
      if (action) {
        if (typeof executeAction !== "function") throw new Error("no executor for a stored resume action");
        await executeAction(action, state);
      } else {
        if (typeof startWorker !== "function") throw new Error("no starter for a parked launch descriptor");
        // ponytail: starts the cell frozen in the descriptor without rechecking
        // usage limits or mark-limited; add a pick/chain check here if specialist
        // resource waits see real use.
        await startWorker({ runId, state });
      }
    } catch (error) {
      const next = postponeResourceWait(runId, { reason: `start failed: ${error.message || error}` }, now, env);
      results.push({ runId, ok: false, reason: "start_worker_failed", error: String(error.message || error), resume_not_before: next });
      continue;
    }

    // The starter already set the worker's mailbox to watching; the parked
    // STATUS (`starting` from createRun) must not be written back over it.
    finishResourceWait(runId, action ? state.capacity.resume_status || "watching" : "watching", now, env, action ? null : "watching");
    resourceStarted = true;
    results.push({ runId, ok: true, resumed: true, reason: "resources" });
  }
  return results;
}

export function capacityWaitsPath(env = process.env) {
  return waitsIndexPath(env);
}

export { runDir };
