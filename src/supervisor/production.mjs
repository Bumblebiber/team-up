import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listActiveStates, loadState, saveState, setStatus, runDir } from "../runs/runs.mjs";
import {
  createAttempt,
  acquireAttemptLease,
  releaseAttemptLease,
  reclaimStaleLease,
  touchAttemptHeartbeat,
} from "./attempts.mjs";
import { materializePartialCheckpoint, validateCheckpoint } from "./checkpoint.mjs";
import { decideTransition, executeTransition, superviseActiveRuns } from "./controller.mjs";
import { loadJson, requireRoster, usagePath } from "../roster/config.mjs";
import { resolveProfile } from "../roster/profile.mjs";
import { chainCapacityReport } from "./capacity.mjs";
import { getAdapter } from "../harness/registry.mjs";
import {
  startFromLaunchDescriptor,
  startSuccessorFromDescriptor,
  resolveLimitWindowsForCell,
} from "./start.mjs";
import { resumeDueWaits } from "./waits.mjs";
import { collectUsage, subscriptionsFromRoster } from "../usage/usage-collect.mjs";

/**
 * Record the first supervised attempt + lease for a specialist launch.
 * Prefer startFromLaunchDescriptor for production starts — this helper remains
 * for tests that only need attempt/lease bookkeeping.
 */
export function beginSupervisedAttempt({
  runId,
  runtime,
  specialist = null,
  now = new Date().toISOString(),
  owner = `starting:pid:${process.pid}`,
  expiresAt = null,
}) {
  const attempt = createAttempt({ runId, runtime, specialist, now });
  const lease = acquireAttemptLease({
    runId,
    attemptId: attempt.id,
    expectedPrevious: null,
    now,
    owner,
    expiresAt:
      expiresAt ??
      new Date(Date.parse(now) + 120_000).toISOString(),
  });
  if (!lease.ok) {
    const err = new Error(`LEASE_FAILED: ${lease.reason}`);
    err.code = "LEASE_FAILED";
    err.details = lease;
    throw err;
  }
  const state = loadState(runId);
  if (state) {
    state.status = "starting";
    state.supervision = {
      ...(state.supervision || {}),
      enabled: true,
      prepare_at: state.supervision?.prepare_at ?? 0.9,
      force_at: state.supervision?.force_at ?? 0.95,
    };
    saveState(state);
    setStatus(runId, "starting");
  }
  return attempt;
}

function heartbeatFresh(state, nowMs, staleSec = 120) {
  const hb = state?.mailbox_heartbeat_at || state?.heartbeat_at;
  if (!hb) return true;
  const t = Date.parse(hb);
  // Malformed timestamps must not be treated as eternally fresh.
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= staleSec * 1000;
}

/**
 * Ingest mailbox/HEARTBEAT before freshness and stale-lease decisions.
 * Accepts ISO text content; rejects malformed values without updating freshness.
 */
export function ingestMailboxHeartbeat(runId, { now = new Date().toISOString() } = {}) {
  const hbPath = path.join(runDir(runId), "mailbox", "HEARTBEAT");
  let raw;
  try {
    raw = fs.readFileSync(hbPath, "utf8").trim();
  } catch (e) {
    if (e.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "unreadable" };
  }
  if (!raw) return { ok: false, reason: "empty" };
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed" };
  // Reject absurd future skew (>1h ahead of supervisor now) as malformed.
  const nowMs = Date.parse(now);
  if (Number.isFinite(nowMs) && ts - nowMs > 3_600_000) {
    return { ok: false, reason: "malformed_future" };
  }
  const iso = new Date(ts).toISOString();
  const st = loadState(runId);
  if (st) {
    st.mailbox_heartbeat_at = iso;
    st.heartbeat_at = iso;
    saveState(st);
    if (st.current_attempt_id) {
      touchAttemptHeartbeat(runId, st.current_attempt_id, iso);
    }
  }
  return { ok: true, at: iso };
}

function processAlive(state) {
  const owner = state?.lease_owner || "";
  if (/^tmux:/.test(owner) || state?.worker?.tmux) {
    const session = state?.worker?.tmux || owner.slice("tmux:".length);
    try {
      execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
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

/**
 * Usage fraction from the current runtime's persisted limit windows only.
 * Unrelated provider windows must not trigger handoff.
 */
export function usedFraction(state, usage) {
  if (typeof state?.usage_used === "number") return state.usage_used;
  const windows = usage?.windows || {};
  const keys = state?.runtime?.limit_windows || state?.worker?.limit_windows || [];
  if (!keys.length) return 0;
  let max = 0;
  for (const k of keys) {
    const u = windows[k]?.used;
    if (typeof u === "number" && u > max) max = u;
  }
  return max;
}

function readMailboxCheckpoint(runId) {
  const dir = path.join(runDir(runId), "mailbox");
  const cpPath = path.join(dir, "CHECKPOINT.json");
  const controlPath = path.join(dir, "CONTROL.json");
  let checkpoint = null;
  let handoffReady = false;
  let control = null;
  try {
    checkpoint = JSON.parse(fs.readFileSync(cpPath, "utf8"));
  } catch {
    checkpoint = null;
  }
  try {
    control = JSON.parse(fs.readFileSync(controlPath, "utf8"));
  } catch {
    control = null;
  }
  const st = loadState(runId);
  const expectedEpoch = st?.handoff?.epoch || control?.handoff_epoch || null;
  const readyFlag = control?.handoff_ready === true || control?.type === "handoff_ready";
  // Ready only counts for the current request epoch — an earlier acknowledgement
  // cannot satisfy a later request_handoff.
  if (readyFlag) {
    if (!expectedEpoch) {
      handoffReady = true;
    } else if (control?.handoff_epoch && control.handoff_epoch === expectedEpoch) {
      handoffReady =
        control.handoff_ready === true || control.type === "handoff_ready";
    } else {
      handoffReady = false;
    }
  }
  return { checkpoint, handoffReady, control, handoffEpoch: expectedEpoch };
}

function persistCapacityWaiting(runId, report, now) {
  const st = loadState(runId);
  if (!st) return;
  st.status = "waiting_capacity";
  st.capacity = {
    blocked_candidates: report?.blocked_candidates || [],
    next_reset_at: report?.next_reset_at ?? null,
    reset_confidence: report?.reset_confidence || "unknown",
    auto_resume: false,
    wait_cancelled: false,
    available_actions: ["wait", "change_roster", "cancel_run"],
    reported_at: now,
  };
  saveState(st);
  setStatus(runId, "waiting_capacity");
  const qPath = path.join(runDir(runId), "mailbox", "QUESTIONS.md");
  fs.mkdirSync(path.dirname(qPath), { recursive: true });
  fs.writeFileSync(
    qPath,
    [
      "# Capacity exhausted",
      "",
      "Exact compatible chain is quota-exhausted.",
      "",
      "```json",
      JSON.stringify(st.capacity, null, 2),
      "```",
      "",
      "Available actions: wait-capacity, change roster, cancel.",
      "Waiting is an explicit human/parent decision (`team-up runs wait-capacity`).",
      "",
    ].join("\n")
  );
}

export function listSupervisedRuns({
  now = new Date().toISOString(),
  usage = null,
  processAliveOverride = null,
} = {}) {
  const nowMs = Date.parse(now);
  const usageDoc = usage || loadJson(usagePath()) || {};
  const out = [];
  for (const state of listActiveStates()) {
    if (!state.supervision?.enabled) continue;
    if (state.status === "waiting_capacity" && state.capacity?.wait_cancelled) continue;
    if (state.status === "waiting_decision") continue;

    // Mailbox HEARTBEAT first — freshness/reclaim must see live worker pulses.
    ingestMailboxHeartbeat(state.runId, { now });

    reclaimStaleLease({
      runId: state.runId,
      now,
      maxAgeMs: (state.supervision?.lease_stale_seconds || 600) * 1000,
    });

    const { checkpoint: mailboxCp, handoffReady } = readMailboxCheckpoint(state.runId);
    let checkpoint = state.checkpoint || null;
    let checkpointForTransition = null;
    if (mailboxCp) {
      const v = validateCheckpoint(mailboxCp, {
        runId: state.runId,
        attemptId: state.current_attempt_id,
      });
      if (v.ok) {
        checkpoint = mailboxCp;
        // Persist drafts always; expose to transition planning only when ready.
        const live = loadState(state.runId);
        if (live) {
          live.checkpoint = mailboxCp;
          if (handoffReady && live.status === "handoff_preparing") {
            live.status = "handing_off";
            setStatus(state.runId, "handing_off");
          }
          saveState(live);
        }
        if (handoffReady) {
          checkpointForTransition = mailboxCp;
        }
      }
    }

    const refreshed = loadState(state.runId) || state;
    const alive =
      typeof processAliveOverride === "function"
        ? processAliveOverride(refreshed)
        : processAlive(refreshed);
    out.push({
      runId: refreshed.runId,
      state:
        refreshed.status === "watching" || refreshed.status === "starting"
          ? "running"
          : refreshed.status === "waiting_capacity"
            ? "waiting_capacity"
            : refreshed.status === "handoff_preparing"
              ? "handoff_preparing"
              : refreshed.status === "handing_off"
                ? "handing_off"
                : "running",
      used: usedFraction(refreshed, usageDoc),
      prepareAt: refreshed.supervision?.prepare_at ?? 0.9,
      forceAt: refreshed.supervision?.force_at ?? 0.95,
      heartbeatFresh: heartbeatFresh(
        refreshed,
        nowMs,
        refreshed.supervision?.heartbeat_stale_seconds ?? 120
      ),
      processAlive: alive,
      capacityAvailable: refreshed.status !== "waiting_capacity",
      checkpoint,
      checkpointForTransition,
      handoffReady,
      release: refreshed.current_attempt_id
        ? { runId: refreshed.runId, attemptId: refreshed.current_attempt_id }
        : null,
      tmuxSession: refreshed.worker?.tmux || null,
      excludeCandidate: refreshed.worker
        ? { cli: refreshed.worker.cli, model: refreshed.worker.model }
        : null,
      controlMessage:
        "Please write mailbox/CHECKPOINT.json (team-up.checkpoint/v1) and set handoff_ready in mailbox/CONTROL.json.",
    });
  }
  return out;
}

function defaultStopTmux(session) {
  if (!session) return;
  try {
    execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
  } catch {
    // already gone
  }
}

function defaultInjectControl(message, ctx = {}) {
  const st = ctx.runId ? loadState(ctx.runId) : null;
  const session = ctx.tmuxSession || st?.worker?.tmux;
  if (!session) {
    throw new Error("injectControl requires a live tmux session");
  }
  const cli = st?.worker?.cli || st?.runtime?.cli || "claude";
  let adapter;
  try {
    adapter = getAdapter(cli);
  } catch {
    adapter = null;
  }
  if (adapter?.injectControl) {
    adapter.injectControl({
      tmuxSession: session,
      message,
      execFileSync,
    });
    return;
  }
  execFileSync("tmux", ["send-keys", "-t", session, "-l", String(message)], {
    stdio: "ignore",
  });
  execFileSync("tmux", ["send-keys", "-t", session, "Enter"], { stdio: "ignore" });
}

/**
 * Production supervision deps — real TMUX inject/stop/start via the unified
 * launch descriptor path. Injected callbacks are optional overrides for tests
 * only; required operations never default to no-ops.
 */
export function buildProductionSuperviseDeps({
  startWorker,
  injectControl,
  stopTmux,
  now = new Date().toISOString(),
  refreshUsageImpl = null,
} = {}) {
  return {
    listSupervisedRuns: async () => listSupervisedRuns({ now }),
    writeControl: async ({ type, at, runId }) => {
      if (!runId) return;
      const dir = path.join(runDir(runId), "mailbox");
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, "CONTROL.json");
      let prev = {};
      try {
        prev = JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {
        prev = {};
      }
      const st = loadState(runId);
      let next = { ...prev, type, at };
      if (type === "request_handoff") {
        // New request epoch: clear any prior ready so a later draft cannot
        // inherit an earlier acknowledgement.
        const epoch = `req-${at || new Date().toISOString()}-${st?.current_attempt_id || "unknown"}`;
        next = {
          ...next,
          handoff_ready: false,
          handoff_epoch: epoch,
          request_attempt_id: st?.current_attempt_id || null,
        };
        if (st) {
          st.status = "handoff_preparing";
          st.handoff = {
            ...(st.handoff || {}),
            epoch,
            requested_at: at || new Date().toISOString(),
            request_attempt_id: st.current_attempt_id || null,
            ready: false,
          };
          // Drop prior readiness-bound checkpoint exposure; drafts may remain
          // on disk but must not satisfy the new epoch until re-acked.
          saveState(st);
          setStatus(runId, "handoff_preparing");
        }
      } else {
        next.handoff_ready = prev.handoff_ready === true;
        if (prev.handoff_epoch) next.handoff_epoch = prev.handoff_epoch;
      }
      fs.writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`);
    },
    injectControl: async (message, ctx) => {
      if (typeof injectControl === "function") {
        await injectControl(message, ctx);
        return;
      }
      defaultInjectControl(message, ctx);
    },
    validateCheckpoint: (cp, ids) => validateCheckpoint(cp, ids),
    releaseLease: async (target) => {
      if (!target?.attemptId && !target?.id) return;
      const runId = target.runId;
      const attemptId = target.attemptId || target.id;
      if (!runId || !attemptId) return;
      releaseAttemptLease({ runId, attemptId, reason: "handoff", now });
    },
    stopTmux: async (session) => {
      if (typeof stopTmux === "function") {
        await stopTmux(session);
        return;
      }
      defaultStopTmux(session);
    },
    refreshUsage: async () => {
      if (typeof refreshUsageImpl === "function") {
        return refreshUsageImpl();
      }
      try {
        const roster = requireRoster();
        const clis = subscriptionsFromRoster(roster).filter((c) => c === "claude");
        // Exact-tier Claude path only — other CLIs remain unsupported for live collect here.
        const results = await collectUsage({
          clis: clis.length ? clis : ["claude"],
          roster,
        });
        const failures = results.filter((r) => !r.ok);
        if (failures.length && !results.some((r) => r.ok)) {
          return {
            ok: false,
            error: `USAGE_REFRESH_FAILED: ${failures.map((f) => `${f.cli}:${f.reason}`).join("; ")}`,
            results,
          };
        }
        return { ok: true, results };
      } catch (e) {
        return {
          ok: false,
          error: `USAGE_REFRESH_FAILED: ${e.message || e}`,
        };
      }
    },
    resolveChain: async (ctx = {}) => {
      const roster = requireRoster();
      const usage = loadJson(usagePath()) || {};
      const st = ctx.runId ? loadState(ctx.runId) : null;
      const profile = st?.specialist_profile || st?.profile || { tier: "frontier", reasoning: "max" };
      let requirements =
        st?.harness_requirements || {};
      if (!requirements?.command_broker) {
        try {
          const { loadAuthoritativeLaunchDescriptor } = await import("./start.mjs");
          const desc = loadAuthoritativeLaunchDescriptor(ctx.runId);
          requirements = desc.harness_requirements || requirements;
        } catch {
          // fall through
        }
      }
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
      const capacity_report = chainCapacityReport({
        profileResult: { ...resolved, chain },
        usage,
        roster,
        now,
      });
      return {
        chain,
        quota_blocked: resolved.quota_blocked || [],
        skipped: resolved.skipped || [],
        code: resolved.code,
        capacity_report,
      };
    },
    createAttempt: async (cell, ctx = {}) => {
      const runId = ctx.runId;
      const st = loadState(runId);
      const roster = requireRoster();
      const limit_windows = resolveLimitWindowsForCell(cell, roster);
      return createAttempt({
        runId,
        runtime: { ...cell, limit_windows },
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
        owner: `starting:pid:${process.pid}`,
        expiresAt: new Date(Date.parse(now) + 120_000).toISOString(),
      });
    },
    startWorker: async (attempt, ctx = {}) => {
      const runId = ctx.runId;
      if (typeof startWorker === "function") {
        await startWorker({ attempt, runId, ...ctx });
        return;
      }
      const cell = attempt.runtime || {};
      await startSuccessorFromDescriptor({
        runId,
        cell,
        attempt,
        now,
      });
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
    loadState: (runId) => loadState(runId),
    persistState: async (patch = {}) => {
      if (!patch.runId) return;
      const st = loadState(patch.runId);
      if (!st) return;
      if (patch.status === "waiting_capacity" && patch.capacity == null && !st.capacity?.reported_at) {
        // Controller entered waiting without a report — leave a stub; caller
        // should have attached capacity via enterWaitingCapacity helper.
      }
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
    persistCapacityReport: async (report, ctx = {}) => {
      if (!ctx.runId) return;
      persistCapacityWaiting(ctx.runId, report, now);
    },
  };
}

export async function superviseProductionRuns({
  now = new Date().toISOString(),
  deps,
} = {}) {
  const resolved = deps || buildProductionSuperviseDeps({ now });
  const results = await superviseActiveRuns({ now, deps: resolved });

  // Production watcher also executes due approved capacity waits.
  try {
    const roster = requireRoster();
    const usage = loadJson(usagePath()) || {};
    await resumeDueWaits({
      now,
      usage,
      roster,
      resolveProfileForRun: async (runId, state) => {
        const profile = state.specialist_profile || state.profile || {
          tier: "frontier",
          reasoning: "max",
        };
        let requirements = state.harness_requirements || {};
        if (!requirements?.command_broker) {
          try {
            const { loadAuthoritativeLaunchDescriptor } = await import("./start.mjs");
            requirements =
              loadAuthoritativeLaunchDescriptor(runId).harness_requirements ||
              requirements;
          } catch {
            // ignore
          }
        }
        return resolveProfile({
          roster,
          usage,
          profile,
          requirements,
        });
      },
      startWorker: async ({ attempt, runId }) => {
        await startFromLaunchDescriptor({
          runId,
          runtimeOverride: attempt.runtime,
          attempt,
          now,
        });
      },
    });
  } catch {
    // capacity resume errors are non-fatal to the supervise tick
  }
  return results;
}

export { decideTransition, executeTransition, chainCapacityReport, persistCapacityWaiting };
