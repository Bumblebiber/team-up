import fs from "node:fs";
import path from "node:path";
import { listActiveStates, loadState, saveState, setStatus, runDir } from "../runs/runs.mjs";
import {
  createAttempt,
  acquireAttemptLease,
  releaseAttemptLease,
  reclaimStaleLease,
} from "./attempts.mjs";
import { materializePartialCheckpoint } from "./checkpoint.mjs";
import { decideTransition, executeTransition, superviseActiveRuns } from "./controller.mjs";
import { loadJson, requireRoster, usagePath } from "../roster/config.mjs";
import { resolveProfile } from "../roster/profile.mjs";
import { chainCapacityReport } from "./capacity.mjs";

/**
 * Record the first supervised attempt + lease for a specialist launch.
 * Production path — not test-only composition.
 */
export function beginSupervisedAttempt({
  runId,
  runtime,
  specialist = null,
  now = new Date().toISOString(),
}) {
  const attempt = createAttempt({ runId, runtime, specialist, now });
  const lease = acquireAttemptLease({
    runId,
    attemptId: attempt.id,
    expectedPrevious: null,
    now,
  });
  if (!lease.ok) {
    const err = new Error(`LEASE_FAILED: ${lease.reason}`);
    err.code = "LEASE_FAILED";
    err.details = lease;
    throw err;
  }
  const state = loadState(runId);
  if (state) {
    state.status = "watching";
    state.supervision = {
      ...(state.supervision || {}),
      enabled: true,
      prepare_at: state.supervision?.prepare_at ?? 0.9,
      force_at: state.supervision?.force_at ?? 0.95,
    };
    saveState(state);
    setStatus(runId, "watching");
  }
  return attempt;
}

function heartbeatFresh(state, nowMs, staleSec = 120) {
  const hb = state?.mailbox_heartbeat_at || state?.heartbeat_at;
  if (!hb) return true;
  const t = Date.parse(hb);
  if (!Number.isFinite(t)) return true;
  return nowMs - t <= staleSec * 1000;
}

function processAlive(state) {
  const pid = state?.worker_pid;
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    return true;
  }
}

function usedFraction(state, usage) {
  if (typeof state?.usage_used === "number") return state.usage_used;
  const windows = usage?.windows || {};
  const keys = state?.runtime?.limit_windows || state?.worker?.limit_windows || [];
  let max = 0;
  for (const k of keys) {
    const u = windows[k]?.used;
    if (typeof u === "number" && u > max) max = u;
  }
  // Fall back to any matching cli window max.
  if (!keys.length) {
    for (const [k, w] of Object.entries(windows)) {
      if (typeof w?.used === "number" && w.used > max) max = w.used;
    }
  }
  return max;
}

export function listSupervisedRuns({ now = new Date().toISOString(), usage = null } = {}) {
  const nowMs = Date.parse(now);
  const usageDoc = usage || loadJson(usagePath()) || {};
  const out = [];
  for (const state of listActiveStates()) {
    if (!state.supervision?.enabled) continue;
    if (state.status === "waiting_capacity" && state.capacity?.wait_cancelled) continue;
    reclaimStaleLease({
      runId: state.runId,
      now,
      maxAgeMs: (state.supervision?.lease_stale_seconds || 600) * 1000,
    });
    out.push({
      runId: state.runId,
      state:
        state.status === "watching"
          ? "running"
          : state.status === "waiting_capacity"
            ? "waiting_capacity"
            : state.status === "handoff_preparing"
              ? "handoff_preparing"
              : state.status === "handing_off"
                ? "handing_off"
                : "running",
      used: usedFraction(state, usageDoc),
      prepareAt: state.supervision?.prepare_at ?? 0.9,
      forceAt: state.supervision?.force_at ?? 0.95,
      heartbeatFresh: heartbeatFresh(state, nowMs, state.supervision?.heartbeat_stale_seconds ?? 120),
      processAlive: processAlive(state),
      capacityAvailable: state.status !== "waiting_capacity",
      checkpoint: state.checkpoint || null,
      release: state.current_attempt_id
        ? { runId: state.runId, attemptId: state.current_attempt_id }
        : null,
      tmuxSession: state.worker?.tmux || null,
      excludeCandidate: state.worker
        ? { cli: state.worker.cli, model: state.worker.model }
        : null,
      controlMessage:
        "Please write a typed checkpoint and set handoff_ready in mailbox/CONTROL.json.",
    });
  }
  return out;
}

export function buildProductionSuperviseDeps({
  startWorker,
  injectControl,
  stopTmux,
  now = new Date().toISOString(),
} = {}) {
  return {
    listSupervisedRuns: async () => listSupervisedRuns({ now }),
    writeControl: async ({ type, at, runId }) => {
      if (!runId) return;
      const dir = path.join(runDir(runId), "mailbox");
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, "CONTROL.json");
      fs.writeFileSync(p, `${JSON.stringify({ type, at }, null, 2)}\n`);
      const st = loadState(runId);
      if (st && type === "request_handoff") {
        st.status = "handoff_preparing";
        saveState(st);
        setStatus(runId, "handoff_preparing");
      }
    },
    injectControl: async (message, ctx) => {
      if (typeof injectControl === "function") {
        await injectControl(message, ctx);
      }
    },
    validateCheckpoint: (cp) => {
      if (!cp) return { ok: true };
      return { ok: true };
    },
    releaseLease: async (target) => {
      if (!target?.attemptId && !target?.id) return;
      const runId = target.runId;
      const attemptId = target.attemptId || target.id;
      if (!runId || !attemptId) return;
      releaseAttemptLease({ runId, attemptId, reason: "handoff", now });
    },
    stopTmux: async (session) => {
      if (session && typeof stopTmux === "function") await stopTmux(session);
    },
    refreshUsage: async () => {},
    resolveChain: async (ctx = {}) => {
      const roster = requireRoster();
      const usage = loadJson(usagePath()) || {};
      const st = ctx.runId ? loadState(ctx.runId) : null;
      const profile = st?.specialist_profile || st?.profile || { tier: "frontier", reasoning: "max" };
      const requirements = st?.harness_requirements || {};
      const resolved = resolveProfile({
        roster,
        usage,
        profile,
        requirements,
      });
      let chain = [...(resolved.chain || [])];
      const exclude = ctx.excludeCandidate;
      if (exclude) {
        chain = chain.filter(
          (c) => !(c.cli === exclude.cli && c.model === exclude.model)
        );
      }
      return {
        chain,
        quota_blocked: resolved.quota_blocked || [],
        skipped: resolved.skipped || [],
        code: resolved.code,
      };
    },
    createAttempt: async (cell, ctx = {}) => {
      const runId = ctx.runId;
      const st = loadState(runId);
      return createAttempt({
        runId,
        runtime: cell,
        specialist: st?.specialist || null,
        now,
      });
    },
    acquireLease: async (attempt, ctx = {}) => {
      const runId = ctx.runId || attempt.runId;
      const st = loadState(runId);
      return acquireAttemptLease({
        runId,
        attemptId: attempt.id,
        expectedPrevious: st?.current_attempt_id ?? null,
        now,
      });
    },
    startWorker: async (attempt, ctx = {}) => {
      if (typeof startWorker !== "function") {
        throw new Error("startWorker required for production handoff");
      }
      await startWorker({ attempt, runId: ctx.runId, ...ctx });
      const st = loadState(ctx.runId);
      if (st) {
        st.status = "watching";
        st.worker = {
          ...(st.worker || {}),
          cli: attempt.runtime?.cli,
          model: attempt.runtime?.model,
        };
        saveState(st);
        setStatus(ctx.runId, "watching");
      }
    },
    appendEvent: async (event, ctx = {}) => {
      const runId = ctx.runId || event.runId;
      if (!runId) return;
      const p = path.join(runDir(runId), "supervision-events.jsonl");
      fs.appendFileSync(p, `${JSON.stringify({ ...event, at: now })}\n`);
    },
    notifyMailbox: async ({ status }, ctx = {}) => {
      if (!ctx.runId || !status) return;
      setStatus(ctx.runId, status);
      const st = loadState(ctx.runId);
      if (st) {
        st.status = status;
        saveState(st);
      }
    },
    persistState: async (patch = {}) => {
      if (!patch.runId) return;
      const st = loadState(patch.runId);
      if (!st) return;
      Object.assign(st, patch);
      delete st.runId;
      st.runId = patch.runId;
      saveState(st);
      if (patch.status) setStatus(patch.runId, patch.status);
    },
    materializePartialCheckpoint: async (ctx) => {
      if (!ctx?.runId || !ctx?.attemptId) return null;
      return materializePartialCheckpoint({
        runId: ctx.runId,
        attemptId: ctx.attemptId,
      });
    },
  };
}

export async function superviseProductionRuns({
  now = new Date().toISOString(),
  deps,
} = {}) {
  const resolved = deps || buildProductionSuperviseDeps({ now });
  return superviseActiveRuns({ now, deps: resolved });
}

export { decideTransition, executeTransition, chainCapacityReport };
