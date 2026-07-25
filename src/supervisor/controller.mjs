import { materializePartialCheckpoint } from "./checkpoint.mjs";

/**
 * Pure handoff transition planner. No TMUX / filesystem side effects.
 */
export function decideTransition({
  state,
  used,
  prepareAt = 0.9,
  forceAt = 0.95,
  heartbeatFresh = true,
  processAlive = true,
  checkpoint = null,
  handoffReady = false,
  capacityAvailable = true,
}) {
  if (!processAlive && state !== "waiting_capacity") {
    return { action: "recover_crash" };
  }
  if (state === "running") {
    if (used >= forceAt) return { action: "force_handoff" };
    if (used >= prepareAt) return { action: "request_handoff" };
    return { action: "noop" };
  }
  if (state === "handoff_preparing") {
    // Draft checkpoints may be persisted, but transition planning requires
    // explicit handoff_ready (95% force path still bypasses via force_handoff).
    if (
      handoffReady &&
      checkpoint &&
      (checkpoint.status === "complete" || checkpoint.status === "partial")
    ) {
      return { action: "complete_handoff" };
    }
    if (used >= forceAt) return { action: "force_handoff" };
    if (heartbeatFresh && processAlive) return { action: "observe" };
    return { action: "force_handoff" };
  }
  if (state === "handing_off") {
    if (!capacityAvailable) return { action: "enter_waiting_capacity" };
    return { action: "complete_handoff" };
  }
  if (state === "waiting_capacity") {
    if (capacityAvailable) return { action: "complete_handoff" };
    return { action: "noop" };
  }
  return { action: "noop" };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Execute a planned transition. Dependencies are injected for tests.
 */
export async function executeTransition(plan, deps = {}) {
  const {
    writeControl,
    injectControl,
    validateCheckpoint,
    releaseLease,
    stopTmux,
    refreshUsage,
    resolveChain,
    createAttempt,
    acquireLease,
    startWorker,
    appendEvent,
    notifyMailbox,
    persistState,
    loadState,
    maxStartRetries = 2,
  } = deps;

  const action = plan.action;
  const ctx = { runId: plan.runId, excludeCandidate: plan.excludeCandidate };

  if (action === "noop" || action === "observe") {
    return { ok: true, action };
  }
  if (action === "request_handoff") {
    await writeControl?.({ type: "request_handoff", at: plan.now, runId: plan.runId });
    await injectControl?.(plan.controlMessage || "Please write a typed checkpoint and set handoff_ready.", ctx);
    await persistState?.({ runId: plan.runId, status: "handoff_preparing" });
    await appendEvent?.({ action }, ctx);
    return { ok: true, action };
  }
  if (action === "force_handoff" || action === "complete_handoff" || action === "recover_crash") {
    let checkpoint = plan.checkpoint;
    if (action === "force_handoff" && !checkpoint) {
      checkpoint = materializePartialCheckpoint({
        runId: plan.runId,
        attemptId: plan.release?.attemptId || plan.currentAttemptId || "unknown",
        now: plan.now,
      });
      await persistState?.({ runId: plan.runId, checkpoint, status: "handing_off" });
    } else if (checkpoint) {
      const v = validateCheckpoint?.(checkpoint) || { ok: true };
      if (!v.ok) return { ok: false, action, errors: v.errors };
      await persistState?.({ runId: plan.runId, checkpoint, status: "handing_off" });
    }

    // Refresh usage BEFORE releasing the lease or stopping the old worker.
    // Stale usage must not drive successor selection; a failed refresh is
    // retryable and must leave the incumbent lease/TMUX intact.
    const refresh = await refreshUsage?.();
    if (refresh && refresh.ok === false) {
      const error =
        refresh.error ||
        refresh.reason ||
        "USAGE_REFRESH_FAILED: refresh returned ok:false";
      await persistState?.({
        runId: plan.runId,
        status: plan.state === "handoff_preparing" ? "handoff_preparing" : "handing_off",
        failure: {
          type: "usage_refresh_failed",
          retryable: true,
          error: String(error),
          at: plan.now || new Date().toISOString(),
        },
        supervision_failure: {
          type: "usage_refresh_failed",
          retryable: true,
          error: String(error),
          at: plan.now || new Date().toISOString(),
        },
        last_error: String(error),
      });
      await appendEvent?.(
        { action, error: String(error), reason: "usage_refresh_failed", retryable: true },
        ctx
      );
      return {
        ok: false,
        action,
        reason: "usage_refresh_failed",
        error: String(error),
        retryable: true,
      };
    }

    await releaseLease?.(plan.release);
    await stopTmux?.(plan.tmuxSession);
    const chainResult = (await resolveChain?.(ctx)) || { chain: [] };
    let chain = [...(chainResult.chain || [])];
    if (plan.excludeCandidate) {
      chain = chain.filter(
        (c) =>
          !(c.cli === plan.excludeCandidate.cli && c.model === plan.excludeCandidate.model)
      );
    }
    if (!chain.length) {
      const report = chainResult.capacity_report || {
        blocked_candidates: chainResult.quota_blocked || [],
        next_reset_at: null,
        reset_confidence: "unknown",
      };
      if (typeof deps.persistCapacityReport === "function") {
        await deps.persistCapacityReport(report, ctx);
      } else {
        await persistState?.({
          runId: plan.runId,
          status: "waiting_capacity",
          capacity: {
            blocked_candidates: report.blocked_candidates || [],
            next_reset_at: report.next_reset_at ?? null,
            reset_confidence: report.reset_confidence || "unknown",
            auto_resume: false,
            wait_cancelled: false,
            available_actions: ["wait", "change_roster", "cancel_run"],
          },
        });
        await notifyMailbox?.({ status: "waiting_capacity" }, ctx);
      }
      await appendEvent?.({ action: "enter_waiting_capacity", capacity: report }, ctx);
      return { ok: true, action: "enter_waiting_capacity", capacity: report };
    }

    const next = await createAttempt?.(chain[0], ctx);
    const lease = await acquireLease?.(next, ctx);
    if (!lease?.ok) {
      await releaseLease?.(next);
      return { ok: false, action, reason: "lease_failed" };
    }

    let lastErr = null;
    for (let i = 0; i <= maxStartRetries; i++) {
      if (i > 0) {
        // Prior start may have released the reservation — reacquire before retry.
        const again = await acquireLease?.(next, ctx);
        if (!again?.ok) {
          lastErr = new Error(`lease_reacquire_failed: ${again?.reason || "unknown"}`);
          break;
        }
      }
      try {
        await startWorker?.(next, ctx);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (i < maxStartRetries) await sleep(25 * (i + 1));
      }
    }
    if (lastErr) {
      await releaseLease?.({
        runId: plan.runId || ctx.runId,
        attemptId: next.id,
        id: next.id,
      });
      await appendEvent?.({ action, error: String(lastErr.message || lastErr) }, ctx);
      return { ok: false, action, reason: "start_worker_failed", error: String(lastErr.message || lastErr) };
    }

    // startWorker already persisted live TMUX/session/sandbox. Never replace
    // worker with next.runtime (no tmux) — reload and merge identity only.
    const runtime = next.runtime || {};
    const live =
      typeof loadState === "function" ? loadState(plan.runId || ctx.runId) : null;
    const patch = {
      runId: plan.runId,
      status: "watching",
      current_attempt_id: next.id,
    };
    if (live) {
      patch.worker = {
        cli: runtime.cli,
        model: runtime.model,
        ...(runtime.effort !== undefined ? { effort: runtime.effort } : {}),
        ...(runtime.limit_windows ? { limit_windows: runtime.limit_windows } : {}),
        ...(live.worker || {}),
      };
      patch.runtime = {
        ...runtime,
        ...(live.runtime || {}),
      };
      if (live.sandbox) patch.sandbox = live.sandbox;
    }
    await persistState?.(patch);
    await appendEvent?.({ action, attempt: next?.id }, ctx);
    await notifyMailbox?.({ status: "watching" }, ctx);
    return { ok: true, action, attempt: next };
  }
  if (action === "enter_waiting_capacity") {
    await notifyMailbox?.({ status: "waiting_capacity" }, ctx);
    await persistState?.({ runId: plan.runId, status: "waiting_capacity" });
    await appendEvent?.({ action }, ctx);
    return { ok: true, action };
  }
  return { ok: false, action, reason: "unknown" };
}

/**
 * Supervise active specialist runs after a usage collection tick.
 */
export async function superviseActiveRuns({ now = new Date().toISOString(), deps = {} } = {}) {
  const runs = (await deps.listSupervisedRuns?.()) || [];
  const results = [];
  for (const run of runs) {
    const handoffReady = run.handoffReady === true;
    const decision = decideTransition({
      state: run.state,
      used: run.used ?? 0,
      prepareAt: run.prepareAt ?? 0.9,
      forceAt: run.forceAt ?? 0.95,
      heartbeatFresh: run.heartbeatFresh !== false,
      processAlive: run.processAlive !== false,
      checkpoint: handoffReady
        ? run.checkpoint || run.checkpointForTransition || null
        : run.checkpointForTransition ?? null,
      handoffReady,
      capacityAvailable: run.capacityAvailable !== false,
    });
    const plan = { ...decision, now, ...run, handoffReady };
    results.push({
      runId: run.runId,
      decision,
      result: await executeTransition(plan, {
        ...deps,
        // Bind runId into mailbox/control helpers that accept ctx as 2nd arg.
        writeControl: deps.writeControl
          ? (msg) => deps.writeControl({ ...msg, runId: run.runId })
          : undefined,
        injectControl: deps.injectControl
          ? (msg) => deps.injectControl(msg, { runId: run.runId })
          : undefined,
        notifyMailbox: deps.notifyMailbox
          ? (msg) => deps.notifyMailbox(msg, { runId: run.runId })
          : undefined,
        appendEvent: deps.appendEvent
          ? (ev) => deps.appendEvent(ev, { runId: run.runId })
          : undefined,
        createAttempt: deps.createAttempt
          ? (cell) => deps.createAttempt(cell, { runId: run.runId })
          : undefined,
        acquireLease: deps.acquireLease
          ? (attempt) => deps.acquireLease(attempt, { runId: run.runId })
          : undefined,
        startWorker: deps.startWorker
          ? (attempt) => deps.startWorker(attempt, { runId: run.runId })
          : undefined,
        resolveChain: deps.resolveChain
          ? () => deps.resolveChain({ runId: run.runId, excludeCandidate: run.excludeCandidate })
          : undefined,
        persistState: deps.persistState,
        releaseLease: deps.releaseLease,
        stopTmux: deps.stopTmux,
        refreshUsage: deps.refreshUsage,
        validateCheckpoint: deps.validateCheckpoint,
        persistCapacityReport: deps.persistCapacityReport
          ? (report) => deps.persistCapacityReport(report, { runId: run.runId })
          : undefined,
        maxStartRetries: deps.maxStartRetries,
      }),
    });
  }
  return results;
}
