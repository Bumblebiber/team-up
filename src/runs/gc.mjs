import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteText,
  classifyMailbox,
  isGcOwnedStaleFailedStatus,
  isMixedLegitimateCloseout,
  isSyntheticStaleFailureState,
  isSyntheticStaleMailboxResult,
  isUnresolvedStalePublicationClaim,
  listAllStates,
  loadState,
  mailboxDir,
  publishFileNoReplace,
  readMailboxStatusIdentity,
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

function setStaleDetected(runId, nowIso, inspectedTmux) {
  return updateState(runId, state => {
    state.cleanup = {
      ...(state.cleanup || {}),
      stale_detected_at: nowIso,
      worker_tmux_id: inspectedTmux?.sessionId || null,
    };
    return state;
  });
}

function clearStaleCandidate(runId) {
  return updateState(runId, state => {
    if (!state.cleanup?.stale_detected_at && !state.cleanup?.stale_publication_claim) {
      return undefined;
    }
    delete state.cleanup.stale_detected_at;
    delete state.cleanup.stale_publication_claim;
    return state;
  });
}

function clearStaleDetected(runId) {
  return clearStaleCandidate(runId);
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

function staleConfirmationMatches(latest, tmuxName, expectedStaleDetectedAt) {
  return (
    ACTIVE.has(latest.status)
    && latest.worker?.tmux === tmuxName
    && latest.cleanup?.stale_detected_at === expectedStaleDetectedAt
  );
}

function sessionIdentityMatches(latest, inspectedTmuxId) {
  const expectedId = latest.cleanup?.worker_tmux_id;
  if (!expectedId || !inspectedTmuxId) return true;
  return expectedId === inspectedTmuxId;
}

function reconcileTerminalMailboxState(state, classified) {
  const wasSyntheticStaleFailure = isSyntheticStaleFailureState(state);
  const resolution = resolveRunState(state, classified);
  state.status = resolution.state.status;
  if (state.cleanup?.stale_detected_at) delete state.cleanup.stale_detected_at;
  if (state.cleanup?.stale_publication_claim) delete state.cleanup.stale_publication_claim;
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

function shouldReconcileTerminalMailbox(state, classified) {
  if (!TERMINAL_MAILBOX.has(classified?.status)) return false;
  if (classified.status !== "failed") return true;
  if (isUnresolvedStalePublicationClaim(state)) {
    if (isMixedLegitimateCloseout(state, state.runId)) return false;
    return false;
  }
  return !isSyntheticStaleMailboxResult(state, state.runId);
}

function createStalePublicationClaim(state, {
  worker_tmux,
  worker_tmux_id,
  stale_detected_at,
  nowIso,
}) {
  return {
    token: `${state.runId}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    worker_tmux,
    worker_tmux_id: worker_tmux_id || null,
    stale_detected_at,
    phase: "claimed",
    claimed_at: nowIso,
  };
}

function publishStaleResult(state) {
  const mb = mailboxDir(state.runId);
  const resultPath = state.result_protocol === "RESULT.json"
    ? path.join(mb, "RESULT.json")
    : path.join(mb, "RESULT.md");
  return publishFileNoReplace(resultPath, staleFailureResultContent(state));
}

function publishStaleStatus(runId) {
  const statusPath = path.join(mailboxDir(runId), "STATUS");
  atomicWriteText(statusPath, "failed\n");
  const stat = fs.statSync(statusPath);
  return { inode: stat.ino, mtimeMs: stat.mtimeMs };
}

function syncClaimResultPhase(claim, state, nowIso) {
  if (claim.phase !== "claimed") return;
  if (isSyntheticStaleMailboxResult(state, state.runId)) {
    claim.phase = "result_published";
    claim.result_published_at = claim.result_published_at || nowIso;
  }
}

function syncClaimStatusPhase(claim, runId, nowIso) {
  if (claim.phase !== "result_published") return;
  if (isGcOwnedStaleFailedStatus(runId, claim)) return;
  const statusIdentity = publishStaleStatus(runId);
  claim.phase = "status_published";
  claim.status_published_at = nowIso;
  claim.status_inode = statusIdentity.inode;
  claim.status_mtime_ms = statusIdentity.mtimeMs;
}

function advanceStalePublicationInState(latest, runId, nowIso, hooks = {}) {
  const claim = latest.cleanup?.stale_publication_claim;
  if (!claim || claim.phase === "finalized" || claim.aborted_at) {
    return { kind: "none" };
  }

  const classified = classifyMailbox(runId);
  if (shouldReconcileTerminalMailbox(latest, classified)) {
    reconcileTerminalMailboxState(latest, classified);
    return { kind: "reconciled", classified };
  }

  if (isMixedLegitimateCloseout(latest, runId)) {
    return { kind: "waiting" };
  }

  syncClaimResultPhase(claim, latest, nowIso);
  syncClaimStatusPhase(claim, runId, nowIso);

  if (claim.phase === "claimed") {
    if (typeof hooks.onBeforeStaleArtifactPublish === "function") {
      hooks.onBeforeStaleArtifactPublish({ runId });
    }
    const classifiedAfterHook = classifyMailbox(runId);
    if (shouldReconcileTerminalMailbox(latest, classifiedAfterHook)) {
      reconcileTerminalMailboxState(latest, classifiedAfterHook);
      return { kind: "reconciled", classified: classifiedAfterHook };
    }
    const publish = publishStaleResult(latest);
    if (!publish.published) {
      const classifiedAfterPublish = classifyMailbox(runId);
      if (shouldReconcileTerminalMailbox(latest, classifiedAfterPublish)) {
        reconcileTerminalMailboxState(latest, classifiedAfterPublish);
        return { kind: "reconciled", classified: classifiedAfterPublish };
      }
      if (!isSyntheticStaleMailboxResult(latest, runId)) {
        return { kind: "waiting" };
      }
    }
    claim.phase = "result_published";
    claim.result_published_at = nowIso;
    if (typeof hooks.onAfterStaleResultPublish === "function") {
      hooks.onAfterStaleResultPublish({ runId });
    }
  }

  if (claim.phase === "result_published" && !isGcOwnedStaleFailedStatus(runId, claim)) {
    const statusIdentity = publishStaleStatus(runId);
    claim.phase = "status_published";
    claim.status_published_at = nowIso;
    claim.status_inode = statusIdentity.inode;
    claim.status_mtime_ms = statusIdentity.mtimeMs;
    if (typeof hooks.onAfterStaleStatusPublish === "function") {
      hooks.onAfterStaleStatusPublish({ runId });
    }
  }

  if (typeof hooks.onAfterStaleArtifactPublish === "function") {
    hooks.onAfterStaleArtifactPublish({
      runId,
      publish: { published: claim.phase === "status_published" || claim.phase === "finalized" },
    });
  }

  if (claim.phase === "status_published") {
    if (isMixedLegitimateCloseout(latest, runId)) {
      return { kind: "waiting" };
    }
    const classifiedAfter = classifyMailbox(runId);
    if (shouldReconcileTerminalMailbox(latest, classifiedAfter)) {
      reconcileTerminalMailboxState(latest, classifiedAfter);
      return { kind: "reconciled", classified: classifiedAfter };
    }
    latest.status = "failed";
    latest.cleanup = {
      ...(latest.cleanup || {}),
      stale_failed_at: nowIso,
      stale_reason: "worker_stale_timeout",
    };
    claim.phase = "finalized";
    claim.finalized_at = nowIso;
    return { kind: "finalized" };
  }

  if (claim.phase === "result_published") {
    return { kind: "in_progress" };
  }

  return { kind: "in_progress" };
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

function attachPendingLeaseRelease(latest, runId, {
  inspectedTmux,
  inspectedTmuxId,
  nowIso,
}) {
  const attemptId = resolveActiveAttemptId(runId, latest);
  const claim = latest.cleanup?.stale_publication_claim;
  const boundTmuxId = claim?.worker_tmux_id || inspectedTmuxId || latest.cleanup?.worker_tmux_id || null;
  if (attemptId) {
    latest.cleanup.pending_lease_release = createPendingLeaseClaim(latest, {
      worker_tmux: inspectedTmux,
      worker_tmux_id: boundTmuxId,
      attempt_id: attemptId,
      nowIso,
    });
  }
}

function transitionStaleFailure(runId, {
  inspectedTmux,
  inspectedTmuxId,
  expectedStaleDetectedAt,
  nowIso,
  onBeforeStaleArtifactPublish = null,
  onAfterStaleArtifactPublish = null,
  onAfterStaleResultPublish = null,
  onAfterStaleStatusPublish = null,
}) {
  let outcome = { kind: "aborted" };
  const hooks = {
    onBeforeStaleArtifactPublish,
    onAfterStaleArtifactPublish,
    onAfterStaleResultPublish,
    onAfterStaleStatusPublish,
  };

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

    if (!latest.cleanup?.stale_publication_claim) {
      latest.cleanup = {
        ...(latest.cleanup || {}),
        stale_publication_claim: createStalePublicationClaim(latest, {
          worker_tmux: inspectedTmux,
          worker_tmux_id: inspectedTmuxId || latest.cleanup?.worker_tmux_id || null,
          stale_detected_at: expectedStaleDetectedAt,
          nowIso,
        }),
      };
      delete latest.cleanup.stale_detected_at;
    }

    const advance = advanceStalePublicationInState(latest, runId, nowIso, hooks);
    if (advance.kind === "reconciled") {
      outcome = { kind: "reconciled", classified: advance.classified };
      return latest;
    }
    if (advance.kind === "waiting") {
      outcome = { kind: "waiting" };
      return latest;
    }
    if (advance.kind === "finalized") {
      attachPendingLeaseRelease(latest, runId, {
        inspectedTmux,
        inspectedTmuxId,
        nowIso,
      });
      outcome = { kind: "failed" };
      return latest;
    }
    outcome = { kind: "in_progress", reason: advance.kind };
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
  let outcome = { authorized: false, obsolete: true };
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

function resumeStalePublicationClaim(runId, {
  nowIso,
  releaseLease,
  stopTmux,
  reportEntry,
  onBeforeStaleArtifactPublish = null,
  onAfterStaleArtifactPublish = null,
  onAfterStaleResultPublish = null,
  onAfterStaleStatusPublish = null,
}) {
  const state = loadState(runId);
  if (!isUnresolvedStalePublicationClaim(state)) return null;

  let advanceOutcome = null;
  updateState(runId, latest => {
    if (!isUnresolvedStalePublicationClaim(latest)) return undefined;
    advanceOutcome = advanceStalePublicationInState(latest, runId, nowIso, {
      onBeforeStaleArtifactPublish,
      onAfterStaleArtifactPublish,
      onAfterStaleResultPublish,
      onAfterStaleStatusPublish,
    });
    if (advanceOutcome.kind === "finalized") {
      const claim = latest.cleanup?.stale_publication_claim;
      attachPendingLeaseRelease(latest, runId, {
        inspectedTmux: claim?.worker_tmux || latest.worker?.tmux,
        inspectedTmuxId: claim?.worker_tmux_id,
        nowIso,
      });
    }
    return latest;
  });

  if (!advanceOutcome) return null;
  if (advanceOutcome.kind === "reconciled") {
    return { action: "reconcile_mailbox" };
  }
  if (advanceOutcome.kind === "waiting" || advanceOutcome.kind === "in_progress") {
    return { action: "pending_publication_claim" };
  }
  if (advanceOutcome.kind === "finalized") {
    const after = loadState(runId);
    const pending = after?.cleanup?.pending_lease_release;
    if (pending?.attempt_id) {
      let releaseResult;
      try {
        releaseResult = releaseLease({
          runId,
          attemptId: pending.attempt_id,
          reason: "worker_stale_timeout",
          now: nowIso,
        });
        releaseResult = resolveNotHolderRelease(releaseResult, runId, pending);
      } catch (error) {
        reportEntry.leaseError = String(error.message || error);
        return { action: "pending_lease", retry: true };
      }
      if (isRetryableLeaseFailure(releaseResult) || !isLeaseReleaseComplete(releaseResult)) {
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
    }
    if (pending?.worker_tmux || pending?.worker_tmux_id) {
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
    const claim = after?.cleanup?.stale_publication_claim;
    try {
      stopTmux(claim?.worker_tmux_id || claim?.worker_tmux || after?.worker?.tmux);
    } catch (error) {
      reportEntry.tmuxError = String(error.message || error);
    }
    return { action: "fail_stale" };
  }
  return null;
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
  onAfterStaleResultPublish,
  onAfterStaleStatusPublish,
  beforeStaleFailureConfirm,
  reportEntry,
}) {
  const tmuxName = state.worker?.tmux;
  const expectedStaleDetectedAt = state.cleanup?.stale_detected_at;
  if (!expectedStaleDetectedAt || !tmuxName) {
    reportEntry.staleFailureAborted = true;
    return;
  }

  const hook = onBeforeStaleConfirmation || beforeStaleFailureConfirm;
  if (typeof hook === "function") {
    hook({ runId: state.runId, inspectedTmux: tmuxName });
  }

  const latest = loadState(state.runId);
  if (!latest) {
    reportEntry.staleFailureAborted = true;
    return;
  }

  const heartbeatMs = heartbeatFor(state.runId);
  const tmux = inspectTmux(tmuxName);
  if (!sessionIdentityMatches(latest, tmux.sessionId)) {
    clearStaleCandidate(state.runId);
    reportEntry.staleFailureAborted = true;
    reportEntry.staleFailureReason = "identity_mismatch";
    return;
  }

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
    inspectedTmux: tmuxName,
    inspectedTmuxId: tmux.sessionId,
    expectedStaleDetectedAt,
    nowIso,
    onBeforeStaleArtifactPublish,
    onAfterStaleArtifactPublish,
    onAfterStaleResultPublish,
    onAfterStaleStatusPublish,
  });
  if (transition.kind === "reconciled") {
    reportEntry.action = "reconcile_mailbox";
    return;
  }
  if (transition.kind === "waiting" || transition.kind === "in_progress") {
    reportEntry.action = "pending_publication_claim";
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
    const boundTmuxId = afterTransition?.cleanup?.stale_publication_claim?.worker_tmux_id
      || afterTransition?.cleanup?.worker_tmux_id
      || tmux.sessionId;
    stopTmux(boundTmuxId || tmuxName);
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
  onAfterStaleResultPublish = null,
  onAfterStaleStatusPublish = null,
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

      const resumed = resumeStalePublicationClaim(state.runId, {
        nowIso,
        releaseLease,
        stopTmux,
        reportEntry,
        onBeforeStaleArtifactPublish,
        onAfterStaleArtifactPublish,
        onAfterStaleResultPublish,
        onAfterStaleStatusPublish,
      });
      if (resumed) {
        reportEntry.action = resumed.action;
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
      setStaleDetected(state.runId, nowIso, tmux);
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
      onAfterStaleResultPublish,
      onAfterStaleStatusPublish,
      beforeStaleFailureConfirm,
      reportEntry,
    });
  }

  return report;
}
