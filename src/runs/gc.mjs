import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteJson,
  atomicWriteText,
  classifyMailbox,
  isSyntheticStaleFailureState,
  listAllStates,
  loadState,
  mailboxDir,
  publishFileNoReplace,
  resolveRunState,
  updateState,
} from "./runs.mjs";
import { inspectTmuxSession, stopTmuxSession } from "./tmux.mjs";
import { readLease, releaseAttemptLease } from "../supervisor/attempts.mjs";

export const IDLE_MS = 30 * 60 * 1000;
export const GRACE_MS = 10 * 60 * 1000;
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const TERMINAL_MAILBOX = new Set(["done", "failed", "cancelled"]);
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

function setStaleDetected(runId, nowIso, inspectTmux = inspectTmuxSession) {
  return updateState(runId, state => {
    const inspected = inspectTmux(state.worker?.tmux || null);
    state.cleanup = {
      ...(state.cleanup || {}),
      stale_detected_at: nowIso,
      worker_tmux_id: inspected.sessionId || null,
    };
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
  return result.reason === "no_lease"
    || result.reason === "already_released"
    || result.reason === "superseded";
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

function reconcileTerminalMailboxState(state, classified) {
  const wasSyntheticStaleFailure = isSyntheticStaleFailureState(state);
  const resolution = resolveRunState(state, classified);
  state.status = resolution.state.status;
  if (state.cleanup?.stale_detected_at) delete state.cleanup.stale_detected_at;
  if (wasSyntheticStaleFailure && TERMINAL_MAILBOX.has(classified?.status)) {
    delete state.cleanup.stale_reason;
    delete state.cleanup.stale_failed_at;
  }
  return state;
}

function staleFailureResultContent(state) {
  if (state.result_protocol === "RESULT.json") {
    return `${JSON.stringify({
      schema: "team-up.result/v1",
      status: "failed",
      summary: "worker_stale_timeout",
    }, null, 2)}\n`;
  }
  return "worker_stale_timeout\n";
}

function readMailboxFile(runId, name) {
  try {
    return fs.readFileSync(path.join(mailboxDir(runId), name), "utf8");
  } catch {
    return null;
  }
}

function isSyntheticStaleMailboxFailure(state) {
  if (state.result_protocol === "RESULT.json") {
    const raw = readMailboxFile(state.runId, "RESULT.json");
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      return parsed?.status === "failed" && parsed?.summary === "worker_stale_timeout";
    } catch {
      return false;
    }
  }
  const md = readMailboxFile(state.runId, "RESULT.md");
  return md?.trim() === "worker_stale_timeout";
}

function shouldReconcileTerminalMailbox(state, classified) {
  if (!TERMINAL_MAILBOX.has(classified?.status)) return false;
  if (classified.status !== "failed") return true;
  return !isSyntheticStaleMailboxFailure(state);
}

function readMailboxStatusLine(runId) {
  try {
    return fs.readFileSync(path.join(mailboxDir(runId), "STATUS"), "utf8").trim();
  } catch {
    return "";
  }
}

function tryPublishStaleFailureArtifacts(state) {
  const mb = mailboxDir(state.runId);
  const statusLine = readMailboxStatusLine(state.runId);
  if (["done", "failed", "cancelled"].includes(statusLine)) {
    return { published: false, reason: "status_terminal" };
  }
  const resultPath = state.result_protocol === "RESULT.json"
    ? path.join(mb, "RESULT.json")
    : path.join(mb, "RESULT.md");
  const resultPublish = publishFileNoReplace(resultPath, staleFailureResultContent(state));
  if (!resultPublish.published) {
    return { published: false, reason: "result_exists" };
  }
  atomicWriteText(path.join(mb, "STATUS"), "failed\n");
  return { published: true };
}

function createPendingLeaseClaim(state, { worker_tmux, worker_tmux_id, attempt_id, nowIso }) {
  return {
    token: `${state.runId}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    worker_tmux,
    worker_tmux_id: worker_tmux_id || null,
    attempt_id,
    recorded_at: nowIso,
    stale_reason: "worker_stale_timeout",
  };
}

function stopAuthorizedTmuxSession(pending, stopTmux) {
  const target = pending?.worker_tmux_id || pending?.worker_tmux;
  if (!target) return;
  stopTmux(target);
}

function tryReconcileSyntheticStaleFailure(runId) {
  const state = loadState(runId);
  if (!isSyntheticStaleFailureState(state)) return null;
  const classified = classifyMailbox(runId);
  if (!TERMINAL_MAILBOX.has(classified?.status) || classified.status === "failed") {
    return null;
  }
  let outcome = null;
  updateState(runId, latest => {
    const latestClassified = classifyMailbox(runId);
    if (!TERMINAL_MAILBOX.has(latestClassified?.status) || latestClassified.status === "failed") {
      return undefined;
    }
    reconcileTerminalMailboxState(latest, latestClassified);
    outcome = { kind: "reconciled", classified: latestClassified };
    return latest;
  });
  return outcome;
}

function transitionStaleFailure(runId, {
  inspectedTmux,
  inspectedTmuxId,
  expectedStaleDetectedAt,
  nowIso,
  onBeforeStaleArtifactPublish = null,
  onAfterStaleArtifactPublish = null,
}) {
  let outcome = { kind: "aborted" };
  updateState(runId, latest => {
    const classified = classifyMailbox(runId);
    if (shouldReconcileTerminalMailbox(latest, classified)) {
      reconcileTerminalMailboxState(latest, classified);
      outcome = { kind: "reconciled", classified };
      return latest;
    }
    if (!staleConfirmationMatches(latest, inspectedTmux, expectedStaleDetectedAt)) {
      return undefined;
    }
    const classifiedAgain = classifyMailbox(runId);
    if (shouldReconcileTerminalMailbox(latest, classifiedAgain)) {
      reconcileTerminalMailboxState(latest, classifiedAgain);
      outcome = { kind: "reconciled", classified: classifiedAgain };
      return latest;
    }
    if (typeof onBeforeStaleArtifactPublish === "function") {
      onBeforeStaleArtifactPublish({ runId });
    }
    const publish = tryPublishStaleFailureArtifacts(latest);
    if (typeof onAfterStaleArtifactPublish === "function") {
      onAfterStaleArtifactPublish({ runId, publish });
    }
    const classifiedAfterPublish = classifyMailbox(runId);
    if (shouldReconcileTerminalMailbox(latest, classifiedAfterPublish)) {
      reconcileTerminalMailboxState(latest, classifiedAfterPublish);
      outcome = { kind: "reconciled", classified: classifiedAfterPublish };
      return latest;
    }
    if (!publish.published) {
      const classifiedExisting = classifyMailbox(runId);
      if (shouldReconcileTerminalMailbox(latest, classifiedExisting)) {
        reconcileTerminalMailboxState(latest, classifiedExisting);
        outcome = { kind: "reconciled", classified: classifiedExisting };
        return latest;
      }
      outcome = { kind: "aborted", reason: publish.reason };
      return undefined;
    }
    latest.status = "failed";
    latest.cleanup = {
      ...(latest.cleanup || {}),
      stale_failed_at: nowIso,
      stale_reason: "worker_stale_timeout",
    };
    delete latest.cleanup.stale_detected_at;
    const attemptId = resolveActiveAttemptId(runId, latest);
    const boundTmuxId = latest.cleanup?.worker_tmux_id || inspectedTmuxId || null;
    if (attemptId) {
      latest.cleanup.pending_lease_release = createPendingLeaseClaim(latest, {
        worker_tmux: inspectedTmux,
        worker_tmux_id: boundTmuxId,
        attempt_id: attemptId,
        nowIso,
      });
    }
    outcome = { kind: "failed" };
    return latest;
  });
  return outcome;
}

function resolveNotHolderRelease(result, runId, pending) {
  if (!result || result.ok !== false || result.reason !== "not_holder") return result;
  if (result.current && result.current !== pending.attempt_id) {
    return { ok: true, reason: "superseded" };
  }
  const lease = readLease(runId);
  if (!lease) return { ok: true, reason: "no_lease" };
  if (lease.released_at != null) return { ok: true, reason: "already_released" };
  if (lease.attempt_id !== pending.attempt_id) return { ok: true, reason: "superseded" };
  return result;
}

function authorizePendingTmuxStop(runId, pending) {
  if (!pending?.token || (!pending.worker_tmux && !pending.worker_tmux_id)) {
    return { authorized: false, obsolete: true };
  }
  let outcome = { authorized: false, obsolete: false };
  updateState(runId, latest => {
    const currentPending = latest.cleanup?.pending_lease_release;
    if (!currentPending || currentPending.token !== pending.token) {
      outcome = { authorized: false, obsolete: true };
      return undefined;
    }
    if (
      latest.status !== "failed"
      || latest.cleanup?.stale_reason !== "worker_stale_timeout"
    ) {
      delete latest.cleanup.pending_lease_release;
      outcome = { authorized: false, obsolete: true };
      return latest;
    }
    const lease = readLease(runId);
    if (
      lease
      && lease.released_at == null
      && lease.attempt_id
      && pending.attempt_id
      && lease.attempt_id !== pending.attempt_id
    ) {
      delete latest.cleanup.pending_lease_release;
      outcome = { authorized: false, obsolete: true };
      return latest;
    }
    delete latest.cleanup.pending_lease_release;
    outcome = { authorized: true, obsolete: false };
    return latest;
  });
  return outcome;
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

  let releaseResult;
  try {
    releaseResult = pending.attempt_id
      ? releaseLease({
        runId,
        attemptId: pending.attempt_id,
        reason: "worker_stale_timeout",
        now: nowIso,
      })
      : { ok: true };
    releaseResult = resolveNotHolderRelease(releaseResult, runId, pending);
  } catch (error) {
    reportEntry.leaseError = String(error.message || error);
    return { action: "pending_lease", retry: true };
  }

  if (isRetryableLeaseFailure(releaseResult)) {
    reportEntry.leaseError = releaseResult.reason;
    return { action: "pending_lease", retry: true };
  }
  if (!isLeaseReleaseComplete(releaseResult)) {
    reportEntry.leaseError = releaseResult?.reason || "lease_release_failed";
    return { action: "pending_lease", retry: true };
  }

  if (releaseResult?.reason === "superseded") {
    updateState(runId, latest => {
      if (latest.cleanup?.pending_lease_release?.token !== pending.token) return undefined;
      delete latest.cleanup.pending_lease_release;
      return latest;
    });
    return { action: "completed_pending_lease", retry: false };
  }

  const auth = authorizePendingTmuxStop(runId, pending);
  if (auth.authorized) {
    try {
      stopAuthorizedTmuxSession(pending, stopTmux);
    } catch (error) {
      reportEntry.tmuxError = String(error.message || error);
    }
  }
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
  onBeforeStaleArtifactPublish,
  onAfterStaleArtifactPublish,
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

  const transition = transitionStaleFailure(state.runId, {
    inspectedTmux,
    inspectedTmuxId: tmux.sessionId,
    expectedStaleDetectedAt,
    nowIso,
    onBeforeStaleArtifactPublish,
    onAfterStaleArtifactPublish,
  });
  if (transition.kind === "reconciled") {
    reportEntry.action = "reconcile_mailbox";
    return;
  }
  if (transition.kind !== "failed") {
    reportEntry.staleFailureAborted = true;
    return;
  }

  const afterTransition = loadState(state.runId);
  const pending = afterTransition?.cleanup?.pending_lease_release;
  if (pending?.attempt_id) {
    let releaseResult;
    try {
      releaseResult = releaseLease({
        runId: state.runId,
        attemptId: pending.attempt_id,
        reason: "worker_stale_timeout",
        now: nowIso,
      });
      releaseResult = resolveNotHolderRelease(releaseResult, state.runId, pending);
    } catch (error) {
      reportEntry.action = "pending_lease";
      reportEntry.leaseError = String(error.message || error);
      return;
    }
    if (isRetryableLeaseFailure(releaseResult) || !isLeaseReleaseComplete(releaseResult)) {
      reportEntry.action = "pending_lease";
      reportEntry.leaseError = releaseResult?.reason || "lease_release_failed";
      return;
    }
    if (releaseResult?.reason === "superseded") {
      updateState(state.runId, latest => {
        if (latest.cleanup?.pending_lease_release?.token !== pending.token) return undefined;
        delete latest.cleanup.pending_lease_release;
        return latest;
      });
      return;
    }
  }

  if (pending?.worker_tmux || pending?.worker_tmux_id) {
    const auth = authorizePendingTmuxStop(state.runId, pending);
    if (auth.authorized) {
      try {
        stopAuthorizedTmuxSession(pending, stopTmux);
      } catch (error) {
        reportEntry.tmuxError = String(error.message || error);
      }
    }
    return;
  }

  try {
    const boundTmuxId = afterTransition?.cleanup?.worker_tmux_id || tmux.sessionId;
    stopTmux(boundTmuxId || inspectedTmux);
  } catch (error) {
    reportEntry.tmuxError = String(error.message || error);
  }
}

export function gcRuns({
  now = new Date(),
  states = null,
  heartbeatFor = heartbeatForRun,
  inspectTmux = inspectTmuxSession,
  stopTmux = stopTmuxSession,
  releaseLease = releaseAttemptLease,
  onBeforeStaleConfirmation = null,
  onBeforeStaleArtifactPublish = null,
  onAfterStaleArtifactPublish = null,
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
      const reconciled = tryReconcileSyntheticStaleFailure(state.runId);
      if (reconciled) {
        reportEntry.action = "reconcile_stale_failure";
        report.runs.push(reportEntry);
        continue;
      }

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
      setStaleDetected(state.runId, nowIso, inspectTmux);
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
      onBeforeStaleArtifactPublish,
      onAfterStaleArtifactPublish,
      beforeStaleFailureConfirm,
      reportEntry,
    });
  }

  return report;
}
