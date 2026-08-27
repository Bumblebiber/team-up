// usage-pty-lock.mjs — cross-process mutex for PTY collectors (zero npm deps).

import fs from "node:fs";
import path from "node:path";

import { isPidAlive } from "../runs/runs.mjs";
import { ptyLockPath as resolvePtyLockPath } from "../paths.mjs";

// One implementation only: paths.mjs honours TEAM_UP_HOME, so a run with its
// own home never contends with a live watcher on the real one.
export function ptyLockPath() {
  return resolvePtyLockPath();
}

/** @returns {boolean} */
export function tryAcquirePtyLock(lockPath = ptyLockPath()) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    try {
      const holder = Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10);
      if (!isPidAlive(holder)) {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
        return true;
      }
    } catch {
      // corrupt lock — best effort remove
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
    return false;
  }
}

export function releasePtyLock(lockPath = ptyLockPath()) {
  try {
    const holder = Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10);
    if (holder === process.pid) fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

/**
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{ lockPath?: string }} [opts]
 * @returns {Promise<{ ok: true, value: T } | { ok: false, reason: 'locked' }>}
 */
export async function withPtyLock(fn, opts = {}) {
  const lockPath = opts.lockPath || ptyLockPath();
  if (!tryAcquirePtyLock(lockPath)) {
    return { ok: false, reason: "locked" };
  }
  try {
    return { ok: true, value: await fn() };
  } finally {
    releasePtyLock(lockPath);
  }
}
