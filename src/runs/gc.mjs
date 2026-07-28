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
import { releaseAttemptLease } from "../supervisor/attempts.mjs";

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

function persistStaleFailure(state, nowIso) {
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
  return updateState(state.runId, latest => {
    latest.status = "failed";
    latest.cleanup = {
      ...(latest.cleanup || {}),
      stale_failed_at: nowIso,
      stale_reason: "worker_stale_timeout",
    };
    return latest;
  });
}

export function gcRuns({
  now = new Date(),
  states = null,
  heartbeatFor = heartbeatForRun,
  inspectTmux = inspectTmuxSession,
  stopTmux = stopTmuxSession,
  releaseLease = releaseAttemptLease,
  dryRun = false,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("gc requires valid now");
  const nowIso = new Date(nowMs).toISOString();
  const input = states || listAllStates();
  const report = { at: nowIso, dryRun, runs: [] };

  for (const snapshot of input) {
    const state = loadState(snapshot.runId) || snapshot;
    const tmux = inspectTmux(state.worker?.tmux || null);
    const decision = evaluateGcAction({
      state,
      nowMs,
      heartbeatMs: heartbeatFor(state.runId),
      tmux,
    });
    report.runs.push({ runId: state.runId, action: decision.kind });
    if (dryRun) continue;

    if (decision.kind === "kill_terminal") {
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

    const failed = persistStaleFailure(state, nowIso);
    if (failed.current_attempt_id) {
      try {
        releaseLease({
          runId: failed.runId,
          attemptId: failed.current_attempt_id,
          reason: "worker_stale_timeout",
          now: nowIso,
        });
      } catch (error) {
        report.runs.at(-1).leaseError = String(error.message || error);
      }
    }
    try {
      stopTmux(failed.worker?.tmux);
    } catch (error) {
      report.runs.at(-1).tmuxError = String(error.message || error);
    }
  }

  return report;
}
