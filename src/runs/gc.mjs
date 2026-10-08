import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteText,
  classifyMailbox,
  listAllStates,
  loadState,
  mailboxDir,
  readMailboxStatusIdentity,
  resolveRunState,
  updateState,
} from "./runs.mjs";
import {
  inspectTmuxSession,
  listTmuxSessions,
  stopTmuxSession,
} from "./tmux.mjs";
import { markVerificationPending, verifierAlive } from "./verification.mjs";
import { gcHandoffs, readHandoffRetentionDays } from "../handoff/store.mjs";
import { loadJson, configPath, usagePath, usageWritePath } from "../roster/config.mjs";
import { pruneExpiredMarks } from "../roster/chain.mjs";

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

const TERMINAL_RUN = new Set(["done", "failed", "cancelled"]);

/** Names team-up actually generates — excludes ad-hoc sessions like team-up-scratch. */
export function isManagedTeamUpSession(name) {
  if (!name || typeof name !== "string") return false;
  return /^team-up-(?:pass|handoff|[a-z][a-z0-9-]*)-[a-z0-9]+$/i.test(name);
}

export function sessionClaimsByTmux(states) {
  const claims = new Map();
  for (const state of states || []) {
    if (state.worker?.tmux) claims.set(state.worker.tmux, state);
    if (state.parent?.tmux) claims.set(state.parent.tmux, state);
  }
  return claims;
}

export function claimedWorkerSessions(states) {
  const claimed = new Set();
  for (const state of states || []) {
    if (TERMINAL_RUN.has(state.status)) continue;
    if (state.worker?.tmux) claimed.add(state.worker.tmux);
    if (state.parent?.tmux) claimed.add(state.parent.tmux);
  }
  return claimed;
}

export function evaluateIdleSessionAction({
  sessionName,
  attached = false,
  activityMs,
  nowMs,
  idleSessionMs,
  sessionClaims,
}) {
  if (!isManagedTeamUpSession(sessionName)) return { kind: "skip" };
  if (sessionName.startsWith("team-up-pass-")) return { kind: "skip" };
  const state = sessionClaims?.get(sessionName);
  if (!state) return { kind: "skip" };
  if (!TERMINAL_RUN.has(state.status)) return { kind: "skip" };
  if (attached) return { kind: "skip" };
  if (!Number.isFinite(activityMs)) return { kind: "skip" };
  if (nowMs - activityMs < idleSessionMs) return { kind: "skip" };
  return { kind: "kill_idle", session: sessionName };
}

export function gcIdleSessions({
  now = new Date(),
  states = [],
  listSessions = listTmuxSessions,
  inspectTmux = inspectTmuxSession,
  stopTmux = stopTmuxSession,
  idleSessionHours = 2,
  dryRun = false,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const idleSessionMs = idleSessionHours * 3_600_000;
  const sessionClaims = sessionClaimsByTmux(states);
  const killed = [];
  const skipped = [];
  const errors = [];

  for (const name of listSessions()) {
    const tmux = inspectTmux(name);
    const decision = evaluateIdleSessionAction({
      sessionName: name,
      attached: tmux.attached,
      activityMs: tmux.activityMs,
      nowMs,
      idleSessionMs,
      sessionClaims,
    });
    if (decision.kind === "skip") {
      skipped.push(name);
      continue;
    }
    if (decision.kind === "kill_idle") {
      if (!dryRun) {
        try {
          stopTmux(name);
        } catch (error) {
          errors.push({ session: name, error: String(error.message || error) });
          continue;
        }
      }
      killed.push(name);
    }
  }
  return { killed, skipped, dryRun, errors };
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
  return { kind: "stale" };
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
    state.cleanup = {
      ...(state.cleanup || {}),
      stale_detected_at: nowIso,
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

/** Adopt a worker's own terminal report while preserving parent verification. */
function adoptTerminalMailbox(runId) {
  const before = loadState(runId);
  if (!before || TERMINAL.has(before.status)) return false;
  const classified = classifyMailbox(runId);
  if (!TERMINAL_MAILBOX.has(classified?.status)) return false;
  if (classified.status === "done" && verifierAlive(mailboxDir(runId), before.verify)) return false;

  const after = updateState(runId, latest => {
    const resolution = resolveRunState(latest, classified);
    if (!resolution.changed) return undefined;
    latest.status = resolution.state.status;
    if (latest.status === "failed" && classified?.error) {
      latest.failure = { error: classified.error, at: new Date().toISOString() };
    }
    markVerificationPending(latest, readMailboxStatusIdentity(runId).mtimeMs);
    if (latest.cleanup?.stale_detected_at) delete latest.cleanup.stale_detected_at;
    return latest;
  });
  return after?.status !== before.status ? after?.status || false : false;
}

export function gcRuns({
  now = new Date(),
  states = null,
  heartbeatFor = heartbeatForRun,
  inspectTmux = inspectTmuxSession,
  stopTmux = stopTmuxSession,
  listSessions = listTmuxSessions,
  dryRun = false,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("gc requires valid now");
  const nowIso = new Date(nowMs).toISOString();
  const input = states || listAllStates();
  const report = { at: nowIso, dryRun, runs: [] };

  for (const snapshot of input) {
    let state = loadState(snapshot.runId) || snapshot;
    if (!dryRun) {
      const adopted = adoptTerminalMailbox(state.runId);
      if (adopted) {
        report.runs.push({
          runId: state.runId,
          action: "adopt_mailbox",
          status: adopted,
          adopted_from_mailbox: adopted,
        });
        state = loadState(state.runId) || state;
      }
    }

    const tmux = inspectTmux(state.worker?.tmux || null);
    const decision = evaluateGcAction({
      state,
      nowMs,
      heartbeatMs: heartbeatFor(state.runId),
      tmux,
    });

    if (decision.kind === "kill_terminal") {
      if (dryRun) {
        report.runs.push({ runId: state.runId, action: "kill_terminal" });
        continue;
      }
      const stopped = stopTmux(state.worker.tmux);
      if (stopped !== false) {
        markTerminalTmuxCleaned(state.runId, nowIso, tmux.sessionId || state.cleanup?.worker_tmux_id || null);
        report.runs.push({ runId: state.runId, action: "kill_terminal" });
      }
      continue;
    }

    if (decision.kind === "mark_stale") {
      if (!dryRun) setStaleDetected(state.runId, nowIso);
      report.runs.push({ runId: state.runId, action: "mark_stale" });
      continue;
    }

    if (decision.kind === "clear_stale") {
      if (!dryRun) clearStaleDetected(state.runId);
      report.runs.push({ runId: state.runId, action: "clear_stale" });
    }
  }

  try {
    const roster = loadJson(configPath());
    const retentionDays = readHandoffRetentionDays(roster, { warn: () => {} });
    report.handoffs = gcHandoffs({ now, retentionDays, dryRun });
  } catch (error) {
    report.handoffs = { error: String(error.message || error) };
  }

  try {
    const { usage, pruned } = pruneExpiredMarks({ usage: loadJson(usagePath()), now: nowMs });
    if (pruned.length && !dryRun) {
      // Atomic: the usage collector writes this file too, and losing that race
      // would restore an old `updated_at` — which is exactly what makes the
      // freshness gate block every dispatch.
      atomicWriteText(usageWritePath(), `${JSON.stringify(usage, null, 2)}\n`);
    }
    report.expired_marks = { pruned, dry_run: Boolean(dryRun) };
  } catch (error) {
    report.expired_marks = { error: String(error.message || error) };
  }

  try {
    const roster = loadJson(configPath()) || {};
    const idleHours = Number(roster?.limits?.idle_session_hours);
    report.idle_sessions = gcIdleSessions({
      now,
      states: input,
      listSessions,
      inspectTmux,
      stopTmux,
      idleSessionHours: Number.isFinite(idleHours) && idleHours > 0 ? idleHours : 2,
      dryRun,
    });
  } catch (error) {
    report.idle_sessions = { error: String(error.message || error) };
  }

  return report;
}
