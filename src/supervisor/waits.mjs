import fs from "node:fs";
import path from "node:path";
import { loadState, saveState, updateState, runDir, setStatus } from "../runs/runs.mjs";
import { chainCapacityReport } from "./capacity.mjs";
import { createAttempt, acquireAttemptLease, releaseAttemptLease } from "./attempts.mjs";
import {
  persistLaunchDescriptor,
  loadAuthoritativeLaunchDescriptor,
  resolveLimitWindowsForCell,
} from "./start.mjs";

function waitsIndexPath(env = process.env) {
  const root = env.TEAM_UP_RUNS || env.O9K_RUNS || path.join(process.env.HOME || "", ".team-up/runs");
  return path.join(path.dirname(root), "capacity-waits.json");
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

export function listDueWaits({ now = new Date().toISOString(), env = process.env } = {}) {
  const nowMs = Date.parse(now);
  const waits = loadWaits(env);
  const due = [];
  for (const [runId, w] of Object.entries(waits.waits || {})) {
    if (!w.auto_resume || w.cancelled) continue;
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
    try {
      const desc = loadAuthoritativeLaunchDescriptor(runId);
      persistLaunchDescriptor(runId, {
        ...desc,
        cli: candidate.cli || desc.cli,
        model: candidate.model || desc.model,
        effort: candidate.effort ?? desc.effort,
        limit_windows,
      });
    } catch {
      // No authoritative descriptor yet — start path may create one later.
    }
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
 */
export async function resumeDueWaits({
  now = new Date().toISOString(),
  env = process.env,
  usage,
  roster,
  profileResult,
  startWorker,
  resolveProfileForRun,
} = {}) {
  const due = listDueWaits({ now, env });
  const results = [];
  for (const runId of due) {
    const state = loadState(runId);
    if (!state?.capacity?.auto_resume || state.capacity?.wait_cancelled) {
      continue;
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
