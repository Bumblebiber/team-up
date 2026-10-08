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

function attemptsLockPath(runId) {
  return path.join(runDir(runId), "ATTEMPTS.lock");
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

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    if (e.code === "EPERM") return true;
    return true;
  }
}

/**
 * Exclusive lock with owner PID + age recovery.
 * A dead controller must not leave a permanent lock_busy.
 */
function withExclusiveLock(lockPath, fn, { maxAgeMs = 120_000 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const tryOpen = () => {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
    return fd;
  };
  let fd;
  try {
    fd = tryOpen();
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let steal = false;
    try {
      const raw = fs.readFileSync(lockPath, "utf8").trim();
      const [pidRaw, ageRaw] = raw.split(/\n/);
      const pid = Number.parseInt(pidRaw, 10);
      const started = Number.parseInt(ageRaw, 10);
      const ownerDead = Number.isInteger(pid) && pid > 0 && !isPidAlive(pid);
      const agedOut =
        Number.isFinite(started) && Date.now() - started > maxAgeMs;
      if (ownerDead || agedOut || !Number.isInteger(pid)) steal = true;
    } catch {
      steal = true;
    }
    if (!steal) return { ok: false, reason: "lock_busy" };
    try {
      fs.unlinkSync(lockPath);
    } catch {
      return { ok: false, reason: "lock_busy" };
    }
    try {
      fd = tryOpen();
    } catch (e2) {
      if (e2.code === "EEXIST") return { ok: false, reason: "lock_busy" };
      throw e2;
    }
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
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

export function createAttempt({ runId, runtime = {}, specialist = null, now = new Date().toISOString() }) {
  const locked = withExclusiveLock(attemptsLockPath(runId), () => {
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
    return { ok: true, record };
  });
  if (!locked.ok) {
    const err = new Error(`ATTEMPT_LOCK_BUSY: concurrent createAttempt for ${runId}`);
    err.code = "ATTEMPT_LOCK_BUSY";
    throw err;
  }
  return locked.record;
}

function withLeaseLock(runId, fn) {
  return withExclusiveLock(leaseLockPath(runId), fn);
}

export function acquireAttemptLease({
  runId,
  attemptId,
  expectedPrevious = null,
  now = new Date().toISOString(),
  owner = `pid:${process.pid}`,
  expiresAt = null,
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
      owner,
      expires_at: expiresAt,
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
    attemptState.lease_owner = owner;
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

/**
 * Reclaim a held lease when ownership expired or heartbeat is stale.
 * Rules:
 * - lease with released_at set → noop
 * - expires_at in the past → reclaim
 * - attempt heartbeat older than maxAgeMs → reclaim
 * - owner `pid:N` and process dead → reclaim
 */
/**
 * Atomically transfer lease ownership (startup reservation → live TMUX worker).
 */
export function readLease(runId) {
  try {
    return JSON.parse(fs.readFileSync(leasePath(runId), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Require an active, unreleased lease matching attemptId.
 */
export function requireActiveLease({ runId, attemptId }) {
  const lease = readLease(runId);
  if (!lease) return { ok: false, reason: "no_lease" };
  if (lease.attempt_id !== attemptId) {
    return { ok: false, reason: "not_holder", current: lease.attempt_id };
  }
  if (lease.released_at != null) {
    return { ok: false, reason: "already_released" };
  }
  return { ok: true, lease };
}

export function transferLeaseOwner({
  runId,
  attemptId,
  owner,
  now = new Date().toISOString(),
  clearExpiry = false,
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
    if (current.released_at != null) {
      return { ok: false, reason: "already_released" };
    }
    current.owner = owner;
    current.transferred_at = now;
    if (clearExpiry) current.expires_at = null;
    atomicWriteJson(leasePath(runId), current);
    try {
      const attemptState = JSON.parse(fs.readFileSync(attemptStatePath(runId, attemptId), "utf8"));
      attemptState.lease_owner = owner;
      attemptState.heartbeat_at = now;
      atomicWriteJson(attemptStatePath(runId, attemptId), attemptState);
    } catch {
      // ignore
    }
    return { ok: true, lease: current };
  });
}

export function listAttempts(runId) {
  return loadAttempts(runId).attempts;
}
