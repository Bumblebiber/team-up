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
  } = deps;

  const action = plan.action;
  if (action === "noop" || action === "observe") {
    return { ok: true, action };
  }
  if (action === "request_handoff") {
    await writeControl?.({ type: "request_handoff", at: plan.now });
    await injectControl?.(plan.controlMessage || "Please write a typed checkpoint and set handoff_ready.");
    await appendEvent?.({ action });
    return { ok: true, action };
  }
  if (action === "force_handoff" || action === "complete_handoff" || action === "recover_crash") {
    if (plan.checkpoint) {
      const v = validateCheckpoint?.(plan.checkpoint) || { ok: true };
      if (!v.ok) return { ok: false, action, errors: v.errors };
    }
    await releaseLease?.(plan.release);
    await stopTmux?.(plan.tmuxSession);
    await refreshUsage?.();
    const chain = (await resolveChain?.()) || { chain: [] };
    if (!chain.chain?.length) {
      await notifyMailbox?.({ status: "waiting_capacity" });
      return { ok: true, action: "enter_waiting_capacity" };
    }
    const next = await createAttempt?.(chain.chain[0]);
    const lease = await acquireLease?.(next);
    if (!lease?.ok) {
      await releaseLease?.(next);
      return { ok: false, action, reason: "lease_failed" };
    }
    await startWorker?.(next);
    await appendEvent?.({ action, attempt: next?.id });
    await notifyMailbox?.({ status: "watching" });
    return { ok: true, action };
  }
  if (action === "enter_waiting_capacity") {
    await notifyMailbox?.({ status: "waiting_capacity" });
    await appendEvent?.({ action });
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
    results.push({
      runId: run.runId,
      decision,
      result: await executeTransition({ ...decision, now, ...run }, deps),
    });
  }
  return results;
}
