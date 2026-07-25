import fs from "node:fs";
import path from "node:path";
import { runDir, atomicWriteJson, loadState, saveState } from "../runs/runs.mjs";

function attemptsIndexPath(runId) {
  return path.join(runDir(runId), "ATTEMPTS.json");
}

function leasePath(runId) {
  return path.join(runDir(runId), "ACTIVE_LEASE.json");
}

function leaseLockPath(runId) {
  return path.join(runDir(runId), "ACTIVE_LEASE.lock");
}

function attemptStatePath(runId, attemptId) {
  return path.join(runDir(runId), "attempts", attemptId, "STATE.json");
}

function loadAttempts(runId) {
  try {
    return JSON.parse(fs.readFileSync(attemptsIndexPath(runId), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { attempts: [] };
    throw e;
  }
}

function saveAttempts(runId, data) {
  atomicWriteJson(attemptsIndexPath(runId), data);
}

function nextAttemptId(attempts) {
  const n = attempts.length + 1;
  return `a${String(n).padStart(4, "0")}`;
}

export function createAttempt({ runId, runtime = {}, specialist = null, now = new Date().toISOString() }) {
  const data = loadAttempts(runId);
  const id = nextAttemptId(data.attempts);
  const record = {
    id,
    created_at: now,
    status: "created",
    runtime,
    specialist,
  };
  data.attempts.push({ id, created_at: now, status: "created" });
  saveAttempts(runId, data);
  fs.mkdirSync(path.dirname(attemptStatePath(runId, id)), { recursive: true });
  atomicWriteJson(attemptStatePath(runId, id), {
    ...record,
    heartbeat_at: null,
  });
  const state = loadState(runId);
  if (state) {
    state.attempt_count = data.attempts.length;
    state.supervision = { ...(state.supervision || {}), enabled: true };
    if (specialist) state.specialist = specialist;
    saveState(state);
  }
  return record;
}

function withLeaseLock(runId, fn) {
  const lock = leaseLockPath(runId);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lock, "wx");
  } catch (e) {
    if (e.code === "EEXIST") {
      return { ok: false, reason: "lease_lock_busy" };
    }
    throw e;
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(lock);
    } catch {
      // ignore
    }
  }
}

export function acquireAttemptLease({
  runId,
  attemptId,
  expectedPrevious = null,
  now = new Date().toISOString(),
}) {
  return withLeaseLock(runId, () => {
    let current = null;
    try {
      current = JSON.parse(fs.readFileSync(leasePath(runId), "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }

    const prevId = current?.attempt_id ?? null;
    if (prevId !== expectedPrevious) {
      return {
        ok: false,
        reason: "expected_previous_mismatch",
        current: prevId,
      };
    }
    if (current && current.released_at == null && prevId != null) {
      return { ok: false, reason: "lease_held", current: prevId };
    }

    const lease = {
      attempt_id: attemptId,
      acquired_at: now,
      released_at: null,
      previous_attempt_id: expectedPrevious,
    };
    atomicWriteJson(leasePath(runId), lease);
    const st = loadState(runId);
    if (st) {
      st.current_attempt_id = attemptId;
      st.supervision = { ...(st.supervision || {}), enabled: true };
      saveState(st);
    }
    const attemptState = JSON.parse(fs.readFileSync(attemptStatePath(runId, attemptId), "utf8"));
    attemptState.status = "active";
    attemptState.heartbeat_at = now;
    atomicWriteJson(attemptStatePath(runId, attemptId), attemptState);
    return { ok: true, lease };
  });
}

export function releaseAttemptLease({
  runId,
  attemptId,
  reason = "released",
  now = new Date().toISOString(),
}) {
  return withLeaseLock(runId, () => {
    let current = null;
    try {
      current = JSON.parse(fs.readFileSync(leasePath(runId), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return { ok: false, reason: "no_lease" };
      throw e;
    }
    if (current.attempt_id !== attemptId) {
      return { ok: false, reason: "not_holder", current: current.attempt_id };
    }
    current.released_at = now;
    current.release_reason = reason;
    atomicWriteJson(leasePath(runId), current);
    try {
      const attemptState = JSON.parse(fs.readFileSync(attemptStatePath(runId, attemptId), "utf8"));
      attemptState.status = reason === "handoff" ? "handed_off" : "released";
      attemptState.released_at = now;
      atomicWriteJson(attemptStatePath(runId, attemptId), attemptState);
    } catch {
      // attempt state optional for crash paths
    }
    return { ok: true, lease: current };
  });
}

export function listAttempts(runId) {
  return loadAttempts(runId).attempts;
}

export function loadAttemptState(runId, attemptId) {
  return JSON.parse(fs.readFileSync(attemptStatePath(runId, attemptId), "utf8"));
}
