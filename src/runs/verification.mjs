// verification.mjs — parent-side post-mailbox command verification (guardrail, not a framework).

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

/** Parse a single --verify-command string into argv (minimal quote awareness). */
export function parseVerifyCommand(str) {
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  const s = (str || "").trim();
  while ((m = re.exec(s)) !== null) {
    parts.push(m[1] ?? m[2] ?? m[3]);
  }
  return parts;
}

/** Opportunistically parse node --test summary lines; never throws. */
export function parseNodeTestCounts(output) {
  const text = String(output || "");
  const tests = text.match(/^# tests (\d+)/m);
  const pass = text.match(/^# pass (\d+)/m);
  const fail = text.match(/^# fail (\d+)/m);
  if (!tests && !pass && !fail) return null;
  const counts = {};
  if (tests) counts.tests = Number(tests[1]);
  if (pass) counts.pass = Number(pass[1]);
  if (fail) counts.fail = Number(fail[1]);
  return counts;
}

function gitHead(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Held while verify.command runs. A file of its own, not the STATE flock:
 * verifying takes minutes, and STATE writers wait two seconds at most.
 */
export const VERIFICATION_LOCK = ".VERIFICATION.lock";

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Pid of the live process verifying in this mailbox, or null. */
export function verifierPid(mb) {
  let pid;
  try {
    pid = Number.parseInt(fs.readFileSync(path.join(mb, VERIFICATION_LOCK), "utf8"), 10);
  } catch {
    return null;
  }
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
}

/**
 * O_EXCL lock in the mailbox. Returns a release function, or null while a
 * live verifier holds it. A lock whose holder died (a killed watcher) is
 * taken over.
 * ponytail: two takers of one dead lock can both win; add a rename-based
 * steal if concurrent watchers on a crashed verifier ever show up.
 */
export function acquireVerificationLock(mb) {
  const lockPath = path.join(mb, VERIFICATION_LOCK);
  const mine = `${process.pid}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, mine, { flag: "wx" });
      return () => {
        try {
          if (fs.readFileSync(lockPath, "utf8") === mine) fs.unlinkSync(lockPath);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (verifierPid(mb)) return null;
    fs.rmSync(lockPath, { force: true });
  }
  return null;
}

/** The verdict already recorded for this exact STATUS=done write, or null. */
export function recordedVerdict(mb, statusMtimeMs) {
  try {
    const report = JSON.parse(fs.readFileSync(path.join(mb, "VERIFICATION.json"), "utf8"));
    if (statusMtimeMs == null || report?.status_mtime_ms !== statusMtimeMs) return null;
    return report.verdict === "pass" || report.verdict === "fail" ? report : null;
  } catch {
    return null;
  }
}

/**
 * Run verify.command `runs` times in state.cwd; write VERIFICATION.json to mailboxDir.
 * `statusMtimeMs` stamps which STATUS=done write the verdict belongs to.
 * @returns {object} verification report
 */
export function runParentVerification(runId, state, { mailboxDir, atomicWriteJson, statusMtimeMs = null }) {
  const verify = state.verify;
  const command = verify?.command;
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error("runParentVerification requires verify.command");
  }
  const cwd = state.cwd;
  const runCount = verify.runs ?? 5;
  const startedAt = new Date().toISOString();
  const runs = [];

  for (let n = 1; n <= runCount; n++) {
    const t0 = Date.now();
    const r = spawnSync(command[0], command.slice(1), {
      cwd,
      encoding: "utf8",
      env: process.env,
    });
    const durationMs = Date.now() - t0;
    const entry = { n, exitCode: r.status ?? 1, durationMs };
    const combined = `${r.stdout || ""}${r.stderr || ""}`;
    const counts = parseNodeTestCounts(combined);
    if (counts) Object.assign(entry, counts);
    runs.push(entry);
  }

  const verdict = runs.every((row) => row.exitCode === 0) ? "pass" : "fail";
  const report = {
    schema: "verification/1",
    command,
    cwd,
    commit: gitHead(cwd),
    startedAt,
    finishedAt: new Date().toISOString(),
    runs,
    verdict,
    ...(statusMtimeMs != null ? { status_mtime_ms: statusMtimeMs } : {}),
  };
  atomicWriteJson(path.join(mailboxDir(runId), "VERIFICATION.json"), report);
  return report;
}
