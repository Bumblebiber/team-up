import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteJson,
  atomicWriteText,
  listAllStates,
  loadState,
  mailboxDir,
  updateState,
} from "./runs.mjs";
import { inspectTmuxSession, stopTmuxSession } from "./tmux.mjs";
import { readLease, releaseAttemptLease } from "../supervisor/attempts.mjs";

export const IDLE_MS = 30 * 60 * 1000;
export const GRACE_MS = 10 * 60 * 1000;
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const ACTIVE = new Set(["starting", "watching"]);
const PROTECTED = new Set([
  "waiting_human",
  "waiting_capacity",
  "waiting_decision",
  "handoff_preparing",
  "handing_off",
]);
const RETRYABLE_LEASE_REASONS = new Set(["lock_busy"]);

function isFresh(timestamp, nowMs, idleMs) {
  return Number.isFinite(timestamp) && nowMs - timestamp < idleMs;
}

export function evaluateGcAction({
  state,
  nowMs,
  heartbeatMs,
  tmux,
  idleMs = IDLE_MS,
  graceMs = GRACE_MS,
}) {
  if (TERMINAL.has(state.status)) {
    return tmux.exists ? { kind: "kill_terminal" } : { kind: "skip" };
  }
  if (PROTECTED.has(state.status) || !ACTIVE.has(state.status)) {
    return { kind: "skip" };
  }
  if (!tmux.exists) return { kind: "skip" };
  if (
    isFresh(heartbeatMs, nowMs, idleMs) ||
    isFresh(tmux.activityMs, nowMs, idleMs)
  ) {
    return state.cleanup?.stale_detected_at
      ? { kind: "clear_stale" }
      : { kind: "noop" };
  }
  const detectedMs = Date.parse(state.cleanup?.stale_detected_at || "");
  if (!Number.isFinite(detectedMs)) return { kind: "mark_stale" };
  if (nowMs - detectedMs < graceMs) return { kind: "grace" };
  return { kind: "fail_stale" };
}

function heartbeatForRun(runId) {
  try {
    const raw = fs.readFileSync(path.join(mailboxDir(runId), "HEARTBEAT"), "utf8").trim();
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function setStaleDetected(runId, nowIso) {
  return updateState(runId, state => {
    state.cleanup = { ...(state.cleanup || {}), stale_detected_at: nowIso };
    return state;
  });
}

function clearStaleDetected(runId) {
  return updateState(runId, state => {
    if (!state.cleanup?.stale_detected_at) return undefined;
    delete state.cleanup.stale_detected_at;
    return state;
  });
}

function resolveActiveAttemptId(runId, state) {
  if (state?.current_attempt_id) return state.current_attempt_id;
  const lease = readLease(runId);
  if (lease?.released_at == null && lease?.attempt_id) {
    return lease.attempt_id;
  }
  return null;
}

function isLeaseReleaseComplete(result) {
  if (!result || result.ok !== false) return true;
  return result.reason === "no_lease" || result.reason === "already_released";
}

function isRetryableLeaseFailure(result) {
  return Boolean(result && !result.ok && RETRYABLE_LEASE_REASONS.has(result.reason));
}

function staleConfirmationMatches(latest, inspectedTmux, expectedStaleDetectedAt) {
  return (
    ACTIVE.has(latest.status)
    && latest.worker?.tmux === inspectedTmux
    && latest.cleanup?.stale_detected_at === expectedStaleDetectedAt
  );
}

function writeStaleFailureArtifacts(state, nowIso) {
  const mb = mailboxDir(state.runId);
  if (state.result_protocol === "RESULT.json") {
    atomicWriteJson(path.join(mb, "RESULT.json"), {
      schema: "team-up.result/v1",
      status: "failed",
      summary: "worker_stale_timeout",
    });
  } else {
    atomicWriteText(path.join(mb, "RESULT.md"), "worker_stale_timeout\n");
  }
  atomicWriteText(path.join(mb, "STATUS"), "failed\n");
}

function compareAndPersistStaleFailure(runId, { inspectedTmux, expectedStaleDetectedAt, nowIso }) {
  let applied = false;
  updateState(runId, latest => {
    if (!staleConfirmationMatches(latest, inspectedTmux, expectedStaleDetectedAt)) {
      return undefined;
    }
    applied = true;
    latest.status = "failed";
    latest.cleanup = {
      ...(latest.cleanup || {}),
      stale_failed_at: nowIso,
      stale_reason: "worker_stale_timeout",
    };
    delete latest.cleanup.stale_detected_at;
    return latest;
  });
  if (!applied) return false;
  writeStaleFailureArtifacts(loadState(runId), nowIso);
  return true;
}

function setPendingLeaseRelease(runId, pending) {
  return updateState(runId, state => {
    state.cleanup = {
      ...(state.cleanup || {}),
      pending_lease_release: pending,
    };
    return state;
  });
}

function clearPendingLeaseRelease(runId) {
  return updateState(runId, state => {
    if (!state.cleanup?.pending_lease_release) return undefined;
    delete state.cleanup.pending_lease_release;
    return state;
  });
}

function tryCompletePendingLeaseRelease({
  runId,
  nowIso,
  releaseLease,
  stopTmux,
  reportEntry,
}) {
  const state = loadState(runId);
  const pending = state?.cleanup?.pending_lease_release;
  if (!pending?.worker_tmux) return null;

  const releaseResult = pending.attempt_id
    ? releaseLease({
      runId,
      attemptId: pending.attempt_id,
      reason: "worker_stale_timeout",
      now: nowIso,
    })
    : { ok: true };

  if (isRetryableLeaseFailure(releaseResult)) {
    reportEntry.leaseError = releaseResult.reason;
    return { action: "pending_lease", retry: true };
  }
  if (!isLeaseReleaseComplete(releaseResult)) {
    reportEntry.leaseError = releaseResult?.reason || "lease_release_failed";
    return { action: "pending_lease", retry: true };
  }

  try {
    stopTmux(pending.worker_tmux);
  } catch (error) {
    reportEntry.tmuxError = String(error.message || error);
  }
  clearPendingLeaseRelease(runId);
  return { action: "completed_pending_lease", retry: false };
}

function executeFailStale({
  state,
  nowIso,
  nowMs,
  heartbeatFor,
  inspectTmux,
  releaseLease,
  stopTmux,
  onBeforeStaleConfirmation,
  beforeStaleFailureConfirm,
  reportEntry,
}) {
  const inspectedTmux = state.worker?.tmux;
  const expectedStaleDetectedAt = state.cleanup?.stale_detected_at;
  if (!expectedStaleDetectedAt || !inspectedTmux) {
    reportEntry.staleFailureAborted = true;
    return;
  }

  const hook = onBeforeStaleConfirmation || beforeStaleFailureConfirm;
  if (typeof hook === "function") {
    hook({ runId: state.runId, inspectedTmux });
  }

  const latest = loadState(state.runId);
  if (!latest) {
    reportEntry.staleFailureAborted = true;
    return;
  }

  const heartbeatMs = heartbeatFor(state.runId);
  const tmux = inspectTmux(inspectedTmux);
  const decision = evaluateGcAction({
    state: latest,
    nowMs,
    heartbeatMs,
    tmux,
  });

  if (decision.kind === "clear_stale") {
    clearStaleDetected(state.runId);
    reportEntry.action = "clear_stale";
    return;
  }
  if (decision.kind !== "fail_stale") {
    reportEntry.staleFailureAborted = true;
    reportEntry.staleFailureReason = decision.kind;
    return;
  }

  if (!compareAndPersistStaleFailure(state.runId, {
    inspectedTmux,
    expectedStaleDetectedAt,
    nowIso,
  })) {
    reportEntry.staleFailureAborted = true;
    return;
  }

  const attemptId = resolveActiveAttemptId(state.runId, loadState(state.runId));
  if (attemptId) {
    const releaseResult = releaseLease({
      runId: state.runId,
      attemptId,
      reason: "worker_stale_timeout",
      now: nowIso,
    });
    if (isRetryableLeaseFailure(releaseResult) || !isLeaseReleaseComplete(releaseResult)) {
      setPendingLeaseRelease(state.runId, {
        attempt_id: attemptId,
        worker_tmux: inspectedTmux,
        recorded_at: nowIso,
      });
      reportEntry.action = "pending_lease";
      reportEntry.leaseError = releaseResult?.reason || "lease_release_failed";
      return;
    }
  }

  try {
    stopTmux(inspectedTmux);
  } catch (error) {
    reportEntry.tmuxError = String(error.message || error);
  }
  clearPendingLeaseRelease(state.runId);
}

export function gcRuns({
  now = new Date(),
  states = null,
  heartbeatFor = heartbeatForRun,
  inspectTmux = inspectTmuxSession,
  stopTmux = stopTmuxSession,
  releaseLease = releaseAttemptLease,
  onBeforeStaleConfirmation = null,
  beforeStaleFailureConfirm = null,
  dryRun = false,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("gc requires valid now");
  const nowIso = new Date(nowMs).toISOString();
  const input = states || listAllStates();
  const report = { at: nowIso, dryRun, runs: [] };

  for (const snapshot of input) {
    const state = loadState(snapshot.runId) || snapshot;
    const reportEntry = { runId: state.runId, action: "skip" };

    if (!dryRun) {
      const pendingResult = tryCompletePendingLeaseRelease({
        runId: state.runId,
        nowIso,
        releaseLease,
        stopTmux,
        reportEntry,
      });
      if (pendingResult) {
        reportEntry.action = pendingResult.action;
        report.runs.push(reportEntry);
        continue;
      }
    }

    const tmux = inspectTmux(state.worker?.tmux || null);
    const decision = evaluateGcAction({
      state,
      nowMs,
      heartbeatMs: heartbeatFor(state.runId),
      tmux,
    });
    reportEntry.action = decision.kind;
    report.runs.push(reportEntry);
    if (dryRun) continue;

    if (decision.kind === "kill_terminal") {
      const pendingAfterFailure = loadState(state.runId)?.cleanup?.pending_lease_release;
      if (pendingAfterFailure) {
        reportEntry.action = "pending_lease";
        continue;
      }
      stopTmux(state.worker.tmux);
      continue;
    }
    if (decision.kind === "mark_stale") {
      setStaleDetected(state.runId, nowIso);
      continue;
    }
    if (decision.kind === "clear_stale") {
      clearStaleDetected(state.runId);
      continue;
    }
    if (decision.kind !== "fail_stale") continue;

    executeFailStale({
      state,
      nowIso,
      nowMs,
      heartbeatFor,
      inspectTmux,
      releaseLease,
      stopTmux,
      onBeforeStaleConfirmation,
      beforeStaleFailureConfirm,
      reportEntry,
    });
  }

  return report;
}
