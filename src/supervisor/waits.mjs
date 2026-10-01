import fs from "node:fs";
import path from "node:path";
import { loadState, saveState, updateState, runDir, setStatus } from "../runs/runs.mjs";
import { chainCapacityReport } from "./capacity.mjs";
import { runsPath } from "../paths.mjs";
import { createAttempt, acquireAttemptLease, releaseAttemptLease } from "./attempts.mjs";
import {
  resolveLimitWindowsForCell,
} from "./start.mjs";

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

export function approveCapacityWait({
  runId,
  nextResetAt,
  now = new Date().toISOString(),
  blockedCandidates = [],
  resetConfidence = "provider",
  env = process.env,
}) {
  const state = loadState(runId);
  if (!state) throw new Error(`unknown run ${runId}`);
  state.status = "waiting_capacity";
  state.capacity = {
    blocked_candidates: blockedCandidates,
    next_reset_at: nextResetAt,
    reset_confidence: resetConfidence,
    auto_resume: true,
    resume_not_before: nextResetAt,
    wait_cancelled: false,
    available_actions: ["cancel-wait", "recheck-capacity", "cancel"],
    approved_at: now,
  };
  saveState(state);
  setStatus(runId, "waiting_capacity");
  const waits = loadWaits(env);
  waits.waits[runId] = {
    runId,
    resume_not_before: nextResetAt,
    auto_resume: true,
    approved_at: now,
  };
  saveWaits(waits, env);
  return state.capacity;
}

export const RESOURCE_RETRY_MS = 2 * 60 * 1000;

/**
 * Park a run until the machine has room (plan 3). `action` is the resume
 * action to replay once admitted (a crashed worker's `spawn_worker`); without
 * one, the run starts from its launch descriptor like a quota wait.
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
      // What the run was before it was parked: a run that asked its human a
      // question goes back to waiting on the answer, not to "watching".
      resume_status: state.status === "waiting_capacity" ? state.capacity?.resume_status ?? "watching" : state.status,
      // The worker's own last word in mailbox/STATUS, put back on resume.
      resume_mailbox_status: state.status === "waiting_capacity" ? state.capacity?.resume_mailbox_status ?? null : mailboxStatus,
      wait_cancelled: false,
      available_actions: ["cancel-wait", "recheck-capacity", "cancel"],
      approved_at: at.toISOString(),
    };
    state.status = "waiting_capacity";
    state.capacity = capacity;
    return state;
  });
  setStatus(runId, "waiting_capacity");
  const waits = loadWaits(env);
  waits.waits[runId] = { runId, resume_not_before: resumeAt, auto_resume: true, approved_at: at.toISOString(), reason: "resources" };
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

function finishResourceWait(runId, status, now, env) {
  let mailboxStatus = null;
  updateState(runId, (state) => {
    mailboxStatus = state.capacity?.resume_mailbox_status ?? null;
    state.status = status;
    state.capacity = { ...(state.capacity || {}), auto_resume: false, resumed_at: now, last_recheck_at: now };
    return state;
  });
  const statusFile = path.join(runDir(runId), "mailbox", "STATUS");
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(statusFile, `${mailboxStatus ?? status}\n`);
  const waits = loadWaits(env);
  delete waits.waits[runId];
  saveWaits(waits, env);
}

export function cancelCapacityWait({ runId, reason = "cancelled", env = process.env }) {
  const state = loadState(runId);
  if (!state) throw new Error(`unknown run ${runId}`);
  state.status = "waiting_decision";
  state.capacity = {
    ...(state.capacity || {}),
    auto_resume: false,
    wait_cancelled: true,
    cancel_reason: reason,
  };
  // Disable generic crash-recovery spawn on `runs resume` as well.
  state.recovery = {
    ...(state.recovery || {}),
    crash_spawn: false,
    cancel_wait_at: new Date().toISOString(),
  };
  saveState(state);
  setStatus(runId, "waiting_decision");
  const waits = loadWaits(env);
  if (waits.waits[runId]) {
    waits.waits[runId].auto_resume = false;
    waits.waits[runId].cancelled = true;
    saveWaits(waits, env);
  }
  // Never delete run files.
  return state;
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

/**
 * Recheck capacity for one wait. When available, create attempt + lease and
 * optionally start the successor via startWorker.
 */
export async function recheckCapacity({
  runId,
  usage,
  roster,
  profileResult,
  now = new Date().toISOString(),
  env = process.env,
  startWorker = null,
}) {
  const state = loadState(runId);
  if (!state?.capacity?.auto_resume) {
    return { ok: false, reason: "auto_resume_disabled" };
  }
  const report = chainCapacityReport({ profileResult, usage, roster, now });
  if (report.available_count > 0) {
    const candidate = report.reports.find((r) => r.available)?.candidate || {};
    const limit_windows = resolveLimitWindowsForCell(candidate, roster);
    const runtime = { ...candidate, limit_windows };
    // Do NOT persist the runtime override here. startFromLaunchDescriptor
    // validates then atomically persists via runtimeOverride; writing first
    // would leave a corrupted descriptor if start later fails closed.
    const attempt = createAttempt({
      runId,
      runtime,
      specialist: state.specialist || null,
      now,
    });
    const prev = state.current_attempt_id || null;
    const lease = acquireAttemptLease({
      runId,
      attemptId: attempt.id,
      expectedPrevious: prev,
      now,
      owner: `starting:pid:${process.pid}`,
      expiresAt: new Date(Date.parse(now) + 120_000).toISOString(),
    });
    if (!lease.ok) {
      return { ok: false, reason: "lease_failed", lease, report };
    }

    if (typeof startWorker === "function") {
      try {
        await startWorker({ attempt, runId, candidate: runtime, report });
      } catch (e) {
        releaseAttemptLease({ runId, attemptId: attempt.id, reason: "start_failed", now });
        const st = loadState(runId);
        st.capacity = {
          ...st.capacity,
          last_resume_error: String(e.message || e),
          last_recheck_at: now,
          resume_retry_after: new Date(Date.parse(now) + 60_000).toISOString(),
        };
        saveState(st);
        const waits = loadWaits(env);
        if (waits.waits[runId]) {
          waits.waits[runId].resume_not_before = st.capacity.resume_retry_after;
          saveWaits(waits, env);
        }
        return { ok: false, reason: "start_worker_failed", error: String(e.message || e), attempt, report };
      }
    }

    updateState(runId, (latest) => {
      // Fill gaps only: startWorker-owned TMUX, sandbox, descriptor/runtime,
      // worker, and limit-window fields from the latest state always win.
      latest.status = "watching";
      latest.capacity = {
        ...(latest.capacity || state.capacity || {}),
        last_recheck_at: now,
        next_reset_at: null,
        last_resume_error: null,
      };
      latest.current_attempt_id = attempt.id;
      latest.runtime = {
        ...runtime,
        ...(latest.runtime || {}),
      };
      if (!latest.runtime.limit_windows && limit_windows) {
        latest.runtime.limit_windows = limit_windows;
      }
      if (candidate.cli || latest.worker) {
        latest.worker = {
          cli: candidate.cli || latest.worker?.cli,
          model: candidate.model || latest.worker?.model,
          limit_windows: limit_windows || latest.worker?.limit_windows,
          ...(latest.worker || {}),
        };
      }
      return latest;
    });
    setStatus(runId, "watching");
    const waits = loadWaits(env);
    delete waits.waits[runId];
    saveWaits(waits, env);
    return { ok: true, resumed: true, attempt, report };
  }
  state.capacity = {
    ...state.capacity,
    blocked_candidates: report.blocked_candidates,
    next_reset_at: report.next_reset_at,
    reset_confidence: report.reset_confidence,
    resume_not_before: report.next_reset_at || state.capacity.resume_not_before,
    last_recheck_at: now,
  };
  saveState(state);
  const waits = loadWaits(env);
  if (waits.waits[runId]) {
    waits.waits[runId].resume_not_before = state.capacity.resume_not_before;
    saveWaits(waits, env);
  }
  return { ok: true, resumed: false, report };
}

/**
 * Durable automatic resume for all due capacity waits.
 *
 * A `reason: "resources"` wait asks `admit(state)` first and moves two
 * minutes on when refused. Admitted, it replays its stored resume action, or
 * falls through to the quota recheck when it has none (a launch that was
 * parked before it ever started). At most one resources wait starts per call:
 * the worker just started has not grown yet, so a second admission in the
 * same breath would judge a machine that is not there any more.
 */
export async function resumeDueWaits({
  now = new Date().toISOString(),
  env = process.env,
  usage,
  roster,
  profileResult,
  startWorker,
  resolveProfileForRun,
  admit = null,
  executeAction = null,
  reason = null,
} = {}) {
  const due = listDueWaits({ now, env, reason });
  const results = [];
  let resourceStarted = false;
  for (const runId of due) {
    const state = loadState(runId);
    if (!state?.capacity?.auto_resume || state.capacity?.wait_cancelled) {
      continue;
    }
    if (state.capacity?.reason === "resources") {
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
      if (action) {
        try {
          if (typeof executeAction !== "function") throw new Error("no executor for a stored resume action");
          await executeAction(action, state);
        } catch (e) {
          const next = postponeResourceWait(runId, { reason: `start failed: ${e.message || e}` }, now, env);
          results.push({ runId, ok: false, reason: "start_worker_failed", error: String(e.message || e), resume_not_before: next });
          continue;
        }
        finishResourceWait(runId, state.capacity.resume_status || "watching", now, env);
        resourceStarted = true;
        results.push({ runId, ok: true, resumed: true, reason: "resources" });
        continue;
      }
      resourceStarted = true;
    }
    let profile = profileResult;
    if (typeof resolveProfileForRun === "function") {
      profile = await resolveProfileForRun(runId, state);
    }
    const result = await recheckCapacity({
      runId,
      usage,
      roster,
      profileResult: profile || { chain: [] },
      now,
      env,
      startWorker,
    });
    results.push({ runId, ...result });
  }
  return results;
}

export function capacityWaitsPath(env = process.env) {
  return waitsIndexPath(env);
}

export { runDir };
