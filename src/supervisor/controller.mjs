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
    if (checkpoint && (checkpoint.status === "complete" || checkpoint.status === "partial")) {
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

    await releaseLease?.(plan.release);
    await stopTmux?.(plan.tmuxSession);
    await refreshUsage?.();
    const chainResult = (await resolveChain?.(ctx)) || { chain: [] };
    let chain = [...(chainResult.chain || [])];
    if (plan.excludeCandidate) {
      chain = chain.filter(
        (c) =>
          !(c.cli === plan.excludeCandidate.cli && c.model === plan.excludeCandidate.model)
      );
    }
    if (!chain.length) {
      await notifyMailbox?.({ status: "waiting_capacity" }, ctx);
      await persistState?.({ runId: plan.runId, status: "waiting_capacity" });
      await appendEvent?.({ action: "enter_waiting_capacity" }, ctx);
      return { ok: true, action: "enter_waiting_capacity" };
    }

    const next = await createAttempt?.(chain[0], ctx);
    const lease = await acquireLease?.(next, ctx);
    if (!lease?.ok) {
      await releaseLease?.(next);
      return { ok: false, action, reason: "lease_failed" };
    }

    let lastErr = null;
    for (let i = 0; i <= maxStartRetries; i++) {
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

    await persistState?.({
      runId: plan.runId,
      status: "watching",
      current_attempt_id: next.id,
      worker: next.runtime,
    });
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
    const decision = decideTransition({
      state: run.state,
      used: run.used ?? 0,
      prepareAt: run.prepareAt ?? 0.9,
      forceAt: run.forceAt ?? 0.95,
      heartbeatFresh: run.heartbeatFresh !== false,
      processAlive: run.processAlive !== false,
      checkpoint: run.checkpoint || null,
      capacityAvailable: run.capacityAvailable !== false,
    });
    const plan = { ...decision, now, ...run };
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
        maxStartRetries: deps.maxStartRetries,
      }),
    });
  }
  return results;
}
