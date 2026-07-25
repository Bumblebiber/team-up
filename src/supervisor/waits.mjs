import fs from "node:fs";
import path from "node:path";
import { loadState, saveState, runDir, setStatus } from "../runs/runs.mjs";
import { chainCapacityReport } from "./capacity.mjs";
import { createAttempt, acquireAttemptLease } from "./attempts.mjs";

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

export function recheckCapacity({
  runId,
  usage,
  roster,
  profileResult,
  now = new Date().toISOString(),
  env = process.env,
}) {
  const state = loadState(runId);
  if (!state?.capacity?.auto_resume) {
    return { ok: false, reason: "auto_resume_disabled" };
  }
  const report = chainCapacityReport({ profileResult, usage, roster, now });
  if (report.available_count > 0) {
    const attempt = createAttempt({
      runId,
      runtime: report.reports.find((r) => r.available)?.candidate || {},
      specialist: state.specialist || null,
      now,
    });
    const prev = state.current_attempt_id || null;
    // If previous lease still held, caller must release first.
    acquireAttemptLease({
      runId,
      attemptId: attempt.id,
      expectedPrevious: prev,
      now,
    });
    state.status = "watching";
    state.capacity = {
      ...state.capacity,
      last_recheck_at: now,
      next_reset_at: null,
    };
    saveState(state);
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

export function capacityWaitsPath(env = process.env) {
  return waitsIndexPath(env);
}

export { runDir };
