import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteText,
  classifyMailbox,
  isSyntheticStaleFailureState,
  isSyntheticStaleMailboxResult,
  isUnresolvedStalePublicationClaim,
  listAllStates,
  loadState,
  mailboxDir,
  publishFileNoReplace,
  readMaybe,
  resolveRunState,
  updateState,
} from "./runs.mjs";
import { inspectTmuxSession, stopTmuxSession, tmuxSessionExists } from "./tmux.mjs";
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

export function isTerminalTmuxAlreadyCleaned(state) {
  return Boolean(state.cleanup?.terminal_tmux_stopped_at);
}

function markTerminalTmuxCleanedState(state, nowIso, sessionId = null) {
  state.cleanup = {
    ...(state.cleanup || {}),
    terminal_tmux_stopped_at: nowIso,
    ...(sessionId ? { worker_tmux_id: sessionId } : {}),
  };
  if (state.worker?.tmux) {
    delete state.worker.tmux;
  }
  return state;
}

function markTerminalTmuxCleaned(runId, nowIso, sessionId = null) {
  return updateState(runId, latest => markTerminalTmuxCleanedState(latest, nowIso, sessionId));
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
    if (isTerminalTmuxAlreadyCleaned(state)) {
      return { kind: "skip" };
    }
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
  const claimStaleAt = latest.cleanup?.stale_publication_claim?.stale_detected_at;
  const candidateAt = latest.cleanup?.stale_detected_at || claimStaleAt;
  return (
    ACTIVE.has(latest.status)
    && latest.worker?.tmux === tmuxName
    && candidateAt === expectedStaleDetectedAt
  );
}

function sessionIdentityMatches(latest, inspectedTmuxId) {
  const expectedId = latest.cleanup?.worker_tmux_id;
  if (!expectedId || !inspectedTmuxId) return true;
  return expectedId === inspectedTmuxId;
}

function reconcileTerminalMailboxState(state, classified) {
  const wasSyntheticStaleFailure = isSyntheticStaleFailureState(state);
  if (state.cleanup?.stale_publication_claim) {
    delete state.cleanup.stale_publication_claim;
  }
  const resolution = resolveRunState(state, classified);
  state.status = resolution.state.status;
  if (state.cleanup?.stale_detected_at) delete state.cleanup.stale_detected_at;
  if (wasSyntheticStaleFailure && TERMINAL_MAILBOX.has(classified?.status)) {
    delete state.cleanup.stale_reason;
    delete state.cleanup.stale_failed_at;
  }
  return state;
}

function reconcileQuestionMailboxState(state, classified) {
  if (state.cleanup?.stale_publication_claim) {
    delete state.cleanup.stale_publication_claim;
  }
  if (isSyntheticStaleFailureState(state)) {
    delete state.cleanup.stale_reason;
    delete state.cleanup.stale_failed_at;
  }
  if (state.cleanup?.stale_detected_at) delete state.cleanup.stale_detected_at;
  state.status = "waiting_human";
  return state;
}

function buildQuestionClassification(state, runId) {
  if (state.result_protocol === "RESULT.json") {
    const raw = readMaybe(path.join(mailboxDir(runId), "RESULT.json"));
    if (!raw || isSyntheticStaleMailboxResult(state, runId)) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.status !== "blocked") return null;
      return {
        status: "question",
        question: (parsed.questions || []).join("\n") || parsed.summary || "blocked",
        resultPath: path.join(mailboxDir(runId), "RESULT.json"),
      };
    } catch {
      return null;
    }
  }
  const questions = readMaybe(path.join(mailboxDir(runId), "QUESTIONS.md"));
  if (!questions?.trim()) return null;
  return {
    status: "question",
    question: questions.trim().slice(0, 2000),
  };
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
}

function hasLegitimateTerminalMailbox(classified, state, runId) {
  if (!TERMINAL_MAILBOX.has(classified?.status)) return false;
  if (classified.status === "failed" && isSyntheticStaleMailboxResult(state, runId)) {
    return false;
  }
  return true;
}

/**
 * Adopt a terminal mailbox into the run's status before anything is decided.
 *
 * A worker that finishes writes its RESULT and sets its mailbox STATUS, and
 * something has to carry that into STATE.json. gc did reconcile — but only
 * inside the stale-failure path, which a run reaches solely by being ACTIVE
 * with a live terminal. A `waiting_human` or `handing_off` run is skipped at
 * the PROTECTED check long before that, so a finished worker whose run never
 * left a protected state stayed "stuck" with its answer sitting unread in the
 * mailbox. Three had accumulated in two days, two of them already done.
 *
 * This invents nothing: it takes the worker's own report, through the same
 * `resolveRunState` that `runs resume` uses, guarded by the same legitimacy
 * check that rejects a synthetic stale result. Runs whose mailbox has not
 * finished are left exactly as they were.
 */
function adoptTerminalMailbox(runId) {
  const before = loadState(runId);
  if (!before || TERMINAL.has(before.status)) return false;
  const classified = classifyMailbox(runId);
  if (!hasLegitimateTerminalMailbox(classified, before, runId)) return false;
  if (isUnresolvedStalePublicationClaim(before)) return false;
  const after = updateState(runId, (latest) =>
    reconcileTerminalMailboxState(latest, classified)
  );
  return after?.status !== before.status ? after.status : false;
}

function deriveStatusFromCanonicalResult(state, runId) {
  if (state.result_protocol === "RESULT.json") {
    const raw = readMaybe(path.join(mailboxDir(runId), "RESULT.json"));
    if (!raw || isSyntheticStaleMailboxResult(state, runId)) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.status === "success" || parsed?.status === "partial") return "done";
      if (parsed?.status === "failed") return "failed";
      if (parsed?.status === "blocked") return "question";
    } catch {
      return null;
    }
    return null;
  }
  const md = readMaybe(path.join(mailboxDir(runId), "RESULT.md"));
  if (!md || isSyntheticStaleMailboxResult(state, runId)) return null;
  return "done";
}

function ensureMailboxStatus(runId, status) {
  const statusPath = path.join(mailboxDir(runId), "STATUS");
  try {
    const existing = fs.readFileSync(statusPath, "utf8").trim();
    if (TERMINAL_MAILBOX.has(existing)) return;
  } catch {
    /* missing STATUS */
  }
  atomicWriteText(statusPath, `${status}\n`);
}

function createStalePublicationClaim(state, {
  worker_tmux,
  worker_tmux_id,
  stale_detected_at,
  attempt_id,
  nowIso,
}) {
  return {
    token: `${state.runId}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    worker_tmux,
    worker_tmux_id: worker_tmux_id || null,
    stale_detected_at,
    attempt_id: attempt_id || null,
    phase: "claimed",
    claimed_at: nowIso,
  };
}

function resolveNotHolderRelease(result, runId, claim) {
  if (!result || result.ok !== false || result.reason !== "not_holder") return result;
  if (result.current && result.current !== claim.attempt_id) {
    return { ok: true, reason: "superseded" };
  }
  const lease = readLease(runId);
  if (!lease) return { ok: true, reason: "no_lease" };
  if (lease.released_at != null) return { ok: true, reason: "already_released" };
  if (claim.attempt_id && lease.attempt_id !== claim.attempt_id) {
    return { ok: true, reason: "superseded" };
  }
  return result;
}

function releaseClaimLease(runId, claim, nowIso, releaseLease, reportEntry) {
  if (!claim.attempt_id) return { ok: true };
  let releaseResult;
  try {
    releaseResult = releaseLease({
      runId,
      attemptId: claim.attempt_id,
      reason: "worker_stale_timeout",
      now: nowIso,
    });
    releaseResult = resolveNotHolderRelease(releaseResult, runId, claim);
  } catch (error) {
    reportEntry.leaseError = String(error.message || error);
    return { ok: false, reason: "exception" };
  }
  if (isRetryableLeaseFailure(releaseResult) || !isLeaseReleaseComplete(releaseResult)) {
    reportEntry.leaseError = releaseResult?.reason || "lease_release_failed";
    return releaseResult || { ok: false, reason: "lease_release_failed" };
  }
  return releaseResult;
}

function stopClaimedTmuxSession(claim, { tmuxExists, stopTmux, reportEntry }) {
  const sessionId = claim.worker_tmux_id;
  if (!sessionId) {
    return { ok: false, reason: "no_immutable_id" };
  }
  if (!tmuxExists(sessionId)) {
    return { ok: true, reason: "already_gone" };
  }
  try {
    stopTmux(sessionId);
  } catch (error) {
    reportEntry.tmuxError = String(error.message || error);
    return { ok: false, reason: "stop_threw" };
  }
  if (tmuxExists(sessionId)) {
    return { ok: false, reason: "still_exists" };
  }
  return { ok: true };
}

function finalizeStaleCleanup(latest, runId, nowIso, hooks = {}) {
  if (typeof hooks.onBeforeStaleArtifactPublish === "function") {
    hooks.onBeforeStaleArtifactPublish({ runId });
  }

  const classified = classifyMailbox(runId);
  if (hasLegitimateTerminalMailbox(classified, latest, runId)) {
    reconcileTerminalMailboxState(latest, classified);
    return { kind: "finalized", reconciled: true };
  }

  if (classified.status === "question" && !isSyntheticStaleMailboxResult(latest, runId)) {
    reconcileQuestionMailboxState(latest, classified);
    return { kind: "finalized", reconciled: true };
  }

  const questionClassified = buildQuestionClassification(latest, runId);
  if (questionClassified) {
    reconcileQuestionMailboxState(latest, questionClassified);
    return { kind: "finalized", reconciled: true, derived: true };
  }

  const derivedStatus = deriveStatusFromCanonicalResult(latest, runId);
  if (derivedStatus) {
    ensureMailboxStatus(runId, derivedStatus);
    const derivedClassified = classifyMailbox(runId);
    if (hasLegitimateTerminalMailbox(derivedClassified, latest, runId)) {
      reconcileTerminalMailboxState(latest, derivedClassified);
      return { kind: "finalized", reconciled: true, derived: true };
    }
  }

  publishStaleResult(latest);
  publishStaleStatus(runId);
  latest.status = "failed";
  latest.cleanup = {
    ...(latest.cleanup || {}),
    stale_failed_at: nowIso,
    stale_reason: "worker_stale_timeout",
  };
  return { kind: "finalized", reconciled: false };
}

function advanceStaleCleanupClaim(latest, runId, nowIso, {
  releaseLease,
  tmuxExists,
  stopTmux,
  reportEntry,
  hooks = {},
}) {
  const claim = latest.cleanup?.stale_publication_claim;
  if (!claim || claim.phase === "finalized" || claim.aborted_at) {
    return { kind: "none" };
  }

  if (claim.phase === "claimed") {
    const releaseResult = releaseClaimLease(runId, claim, nowIso, releaseLease, reportEntry);
    if (!isLeaseReleaseComplete(releaseResult)) {
      return { kind: "retry_lease" };
    }
    if (releaseResult?.reason === "superseded") {
      delete latest.cleanup.stale_publication_claim;
      return { kind: "aborted", reason: "superseded" };
    }
    claim.phase = "lease_released";
    claim.lease_released_at = nowIso;
  }

  if (claim.phase === "lease_released") {
    if (
      !ACTIVE.has(latest.status)
      || latest.worker?.tmux !== claim.worker_tmux
    ) {
      delete latest.cleanup.stale_publication_claim;
      return { kind: "aborted", reason: "worker_recovered" };
    }
    if (!claim.worker_tmux_id) {
      claim.aborted_at = nowIso;
      claim.abort_reason = "no_immutable_id";
      delete latest.cleanup.stale_publication_claim;
      return { kind: "aborted", reason: "no_immutable_id" };
    }
    const stopResult = stopClaimedTmuxSession(claim, { tmuxExists, stopTmux, reportEntry });
    if (!stopResult.ok) {
      return { kind: "retry_stop" };
    }
    claim.phase = "tmux_stopped";
    claim.tmux_stopped_at = nowIso;
    markTerminalTmuxCleanedState(latest, nowIso, claim.worker_tmux_id);
    if (typeof hooks.onAfterTmuxStopped === "function") {
      hooks.onAfterTmuxStopped({ runId });
    }
  }

  if (claim.phase === "tmux_stopped") {
    markTerminalTmuxCleanedState(latest, claim.tmux_stopped_at || nowIso, claim.worker_tmux_id);
    const finalize = finalizeStaleCleanup(latest, runId, nowIso, hooks);
    claim.phase = "finalized";
    claim.finalized_at = nowIso;
    delete latest.cleanup.stale_publication_claim;
    if (typeof hooks.onAfterStaleArtifactPublish === "function") {
      hooks.onAfterStaleArtifactPublish({ runId, publish: { published: true } });
    }
    return finalize;
  }

  return { kind: "in_progress" };
}

function transitionStaleFailure(runId, {
  inspectedTmux,
  inspectedTmuxId,
  expectedStaleDetectedAt,
  nowIso,
  releaseLease,
  tmuxExists,
  stopTmux,
  reportEntry,
  hooks = {},
}) {
  if (!inspectedTmuxId) {
    reportEntry.staleFailureAborted = true;
    reportEntry.staleFailureReason = "no_immutable_id";
    return { kind: "aborted" };
  }

  let outcome = { kind: "aborted" };

  const preClaim = loadState(runId);
  if (
    preClaim
    && staleConfirmationMatches(preClaim, inspectedTmux, expectedStaleDetectedAt)
    && !preClaim.cleanup?.stale_publication_claim
  ) {
    const classifiedBeforeClaim = classifyMailbox(runId);
    if (hasLegitimateTerminalMailbox(classifiedBeforeClaim, preClaim, runId)) {
      updateState(runId, latest => {
        if (!staleConfirmationMatches(latest, inspectedTmux, expectedStaleDetectedAt)) {
          return undefined;
        }
        reconcileTerminalMailboxState(latest, classifiedBeforeClaim);
        return latest;
      });
      return { kind: "reconciled", classified: classifiedBeforeClaim };
    }

    updateState(runId, latest => {
      if (!staleConfirmationMatches(latest, inspectedTmux, expectedStaleDetectedAt)) {
        return undefined;
      }
      if (latest.cleanup?.stale_publication_claim) return undefined;
      const attemptId = resolveActiveAttemptId(runId, latest);
      latest.cleanup = {
        ...(latest.cleanup || {}),
        stale_publication_claim: createStalePublicationClaim(latest, {
          worker_tmux: inspectedTmux,
          worker_tmux_id: inspectedTmuxId,
          stale_detected_at: expectedStaleDetectedAt,
          attempt_id: attemptId,
          nowIso,
        }),
      };
      delete latest.cleanup.stale_detected_at;
      return latest;
    });

    if (typeof hooks.onAfterClaim === "function") {
      hooks.onAfterClaim({ runId });
    }

    const classifiedAfterClaim = classifyMailbox(runId);
    const afterClaim = loadState(runId);
    if (afterClaim && hasLegitimateTerminalMailbox(classifiedAfterClaim, afterClaim, runId)) {
      updateState(runId, latest => {
        reconcileTerminalMailboxState(latest, classifiedAfterClaim);
        delete latest.cleanup.stale_publication_claim;
        return latest;
      });
      return { kind: "reconciled", classified: classifiedAfterClaim };
    }
  }

  updateState(runId, latest => {
    const classified = classifyMailbox(runId);
    if (hasLegitimateTerminalMailbox(classified, latest, runId)) {
      reconcileTerminalMailboxState(latest, classified);
      outcome = { kind: "reconciled", classified };
      return latest;
    }

    if (!staleConfirmationMatches(latest, inspectedTmux, expectedStaleDetectedAt)) {
      return undefined;
    }

    if (!latest.cleanup?.stale_publication_claim) {
      return undefined;
    }

    const advance = advanceStaleCleanupClaim(latest, runId, nowIso, {
      releaseLease,
      tmuxExists,
      stopTmux,
      reportEntry,
      hooks,
    });

    if (advance.kind === "finalized") {
      outcome = advance.reconciled
        ? { kind: "reconciled", classified: classifyMailbox(runId) }
        : { kind: "failed" };
      return latest;
    }
    if (advance.kind === "aborted") {
      outcome = { kind: "aborted", reason: advance.reason };
      return latest;
    }
    if (advance.kind === "retry_lease") {
      outcome = { kind: "pending_claim" };
      return latest;
    }
    if (advance.kind === "retry_stop") {
      outcome = { kind: "pending_claim" };
      return latest;
    }
    outcome = { kind: "pending_claim" };
    return latest;
  });

  return outcome;
}

function resumeStaleCleanupClaim(runId, {
  nowIso,
  releaseLease,
  tmuxExists,
  stopTmux,
  reportEntry,
  hooks = {},
}) {
  const state = loadState(runId);
  if (!isUnresolvedStalePublicationClaim(state)) return null;

  let advanceOutcome = null;
  updateState(runId, latest => {
    if (!isUnresolvedStalePublicationClaim(latest)) return undefined;
    advanceOutcome = advanceStaleCleanupClaim(latest, runId, nowIso, {
      releaseLease,
      tmuxExists,
      stopTmux,
      reportEntry,
      hooks,
    });
    return latest;
  });

  if (!advanceOutcome) return null;
  if (advanceOutcome.kind === "finalized") {
    return {
      action: advanceOutcome.reconciled ? "reconcile_mailbox" : "fail_stale",
    };
  }
  if (advanceOutcome.kind === "retry_lease") {
    return { action: "pending_lease", retry: true };
  }
  if (advanceOutcome.kind === "retry_stop") {
    return { action: "pending_claim", retry: true };
  }
  if (advanceOutcome.kind === "aborted") {
    return { action: "stale_failure_aborted", reason: advanceOutcome.reason };
  }
  return { action: "pending_claim" };
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

function executeFailStale({
  state,
  nowIso,
  nowMs,
  heartbeatFor,
  inspectTmux,
  releaseLease,
  tmuxExists,
  stopTmux,
  onBeforeStaleConfirmation,
  onBeforeStaleArtifactPublish,
  onAfterStaleArtifactPublish,
  onAfterClaim,
  onAfterTmuxStopped,
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
  const boundTmuxId = tmux.sessionId || latest.cleanup?.worker_tmux_id || null;
  if (!boundTmuxId) {
    reportEntry.staleFailureAborted = true;
    reportEntry.staleFailureReason = "no_immutable_id";
    return;
  }
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

  const hooks = {
    onBeforeStaleArtifactPublish,
    onAfterStaleArtifactPublish,
    onAfterClaim,
    onAfterTmuxStopped,
  };

  const transition = transitionStaleFailure(state.runId, {
    inspectedTmux: tmuxName,
    inspectedTmuxId: boundTmuxId,
    expectedStaleDetectedAt,
    nowIso,
    releaseLease,
    tmuxExists,
    stopTmux,
    reportEntry,
    hooks,
  });

  if (transition.kind === "reconciled") {
    reportEntry.action = "reconcile_mailbox";
    return;
  }
  if (transition.kind === "aborted") {
    reportEntry.staleFailureAborted = true;
    reportEntry.staleFailureReason = transition.reason || "aborted";
    return;
  }
  if (transition.kind === "pending_claim") {
    reportEntry.action = isUnresolvedStalePublicationClaim(loadState(state.runId))
      && loadState(state.runId)?.cleanup?.stale_publication_claim?.phase === "claimed"
      && reportEntry.leaseError
      ? "pending_lease"
      : "pending_claim";
    return;
  }
  if (transition.kind === "failed") {
    reportEntry.action = "fail_stale";
    return;
  }

  reportEntry.staleFailureAborted = true;
}

export function gcRuns({
  now = new Date(),
  states = null,
  heartbeatFor = heartbeatForRun,
  inspectTmux = inspectTmuxSession,
  tmuxExists = tmuxSessionExists,
  stopTmux = stopTmuxSession,
  releaseLease = releaseAttemptLease,
  onBeforeStaleConfirmation = null,
  onBeforeStaleArtifactPublish = null,
  onAfterStaleArtifactPublish = null,
  onAfterClaim = null,
  onAfterTmuxStopped = null,
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

      const resumed = resumeStaleCleanupClaim(state.runId, {
        nowIso,
        releaseLease,
        tmuxExists,
        stopTmux,
        reportEntry,
        hooks: {
          onBeforeStaleArtifactPublish,
          onAfterStaleArtifactPublish,
          onAfterTmuxStopped,
        },
      });
      if (resumed) {
        reportEntry.action = resumed.action;
        report.runs.push(reportEntry);
        continue;
      }
    }

    // Before deciding anything: if the worker already reported, take its word.
    // Otherwise a run that finished while protected is never looked at again.
    let current = state;
    if (!dryRun) {
      const adopted = adoptTerminalMailbox(state.runId);
      if (adopted) {
        reportEntry.adopted_from_mailbox = adopted;
        current = loadState(state.runId) || state;
      }
    }

    const tmux = inspectTmux(current.worker?.tmux || null);
    const decision = evaluateGcAction({
      state: current,
      nowMs,
      heartbeatMs: heartbeatFor(current.runId),
      tmux,
    });
    reportEntry.action = decision.kind;
    report.runs.push(reportEntry);
    if (dryRun) continue;

    if (decision.kind === "kill_terminal") {
      if (isUnresolvedStalePublicationClaim(loadState(state.runId))) {
        reportEntry.action = "pending_claim";
        continue;
      }
      const sessionId = tmux.sessionId || state.cleanup?.worker_tmux_id || null;
      const stopped = stopTmux(state.worker.tmux);
      if (stopped === false) {
        continue;
      }
      markTerminalTmuxCleaned(state.runId, nowIso, sessionId);
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
      tmuxExists,
      stopTmux,
      onBeforeStaleConfirmation,
      onBeforeStaleArtifactPublish,
      onAfterStaleArtifactPublish,
      onAfterClaim,
      onAfterTmuxStopped,
      beforeStaleFailureConfirm,
      reportEntry,
    });
  }

  return report;
}
