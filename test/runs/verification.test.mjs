import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRun,
  loadState,
  runDir,
  waitMailbox,
  atomicWriteText,
  atomicWriteJson,
  setStatus,
  updateState,
  parseVerifyCommand,
  parseNodeTestCounts,
  runParentVerification,
} from "../../src/runs/runs.mjs";
import { gcRuns } from "../../src/runs/gc.mjs";
import { acquireVerificationLock } from "../../src/runs/verification.mjs";

const RUNS_BIN = fileURLToPath(new URL("../../src/runs/runs.mjs", import.meta.url));

function withTempRuns(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-verify-runs-"));
    const prev = process.env.O9K_RUNS;
    process.env.O9K_RUNS = dir;
    try {
      await fn(dir);
    } finally {
      if (prev === undefined) delete process.env.O9K_RUNS;
      else process.env.O9K_RUNS = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function counterScript(counterPath, failAt) {
  const body = [
    "const fs=require('node:fs');",
    `const f=${JSON.stringify(counterPath)};`,
    "const n=(Number(fs.readFileSync(f,'utf8')||0))+1;",
    "fs.writeFileSync(f,String(n));",
    `process.exit(n===${failAt}?1:0);`,
  ].join("");
  return [process.execPath, "-e", body];
}

function closeMailboxDone(runId) {
  const mb = path.join(runDir(runId), "mailbox");
  atomicWriteText(path.join(mb, "RESULT.md"), "worker claims green\n");
  atomicWriteText(path.join(mb, "STATUS"), "done");
}

test("parseVerifyCommand splits quoted shell words", () => {
  assert.deepEqual(parseVerifyCommand('npm test'), ["npm", "test"]);
  assert.deepEqual(parseVerifyCommand("node -e 'console.log(1)'"), ["node", "-e", "console.log(1)"]);
});

test("parseNodeTestCounts extracts node --test summary", () => {
  const out = "# tests 413\n# pass 413\n# fail 0\n";
  assert.deepEqual(parseNodeTestCounts(out), { tests: 413, pass: 413, fail: 0 });
});

test("parseNodeTestCounts returns null when absent", () => {
  assert.equal(parseNodeTestCounts("all good\n"), null);
});

test("createRun stores verify with default runs=5", withTempRuns(async () => {
  const state = createRun({
    cwd: "/tmp/p",
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
    verify: { command: ["npm", "test"] },
  });
  const loaded = loadState(state.runId);
  assert.deepEqual(loaded.verify, { command: ["npm", "test"], runs: 5 });
}));

test("createRun without verify leaves state unchanged", withTempRuns(async () => {
  const state = createRun({
    cwd: "/tmp/p",
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
  });
  assert.equal(loadState(state.runId).verify, undefined);
}));

test("all passing runs → verdict pass and waitMailbox success", withTempRuns(async (runsRoot) => {
  const counter = path.join(runsRoot, "ok-counter");
  fs.writeFileSync(counter, "0");
  const cmd = counterScript(counter, 999);
  const state = createRun({
    cwd: runsRoot,
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
    verify: { command: cmd, runs: 3 },
  });
  setStatus(state.runId, "watching");
  closeMailboxDone(state.runId);

  const result = waitMailbox(state.runId, { ceilingSec: 1, observe: false });
  assert.equal(result.classified.status, "done");
  assert.equal(loadState(state.runId).status, "done");

  const report = JSON.parse(
    fs.readFileSync(path.join(runDir(state.runId), "mailbox", "VERIFICATION.json"), "utf8"),
  );
  assert.equal(report.schema, "verification/1");
  assert.equal(report.verdict, "pass");
  assert.equal(report.runs.length, 3);
  assert.ok(report.runs.every((r) => r.exitCode === 0));
}));

test("pass four fail fifth → verdict fail (340-pass incident shape)", withTempRuns(async (runsRoot) => {
  const counter = path.join(runsRoot, "flaky-counter");
  fs.writeFileSync(counter, "0");
  const cmd = counterScript(counter, 5);
  const state = createRun({
    cwd: runsRoot,
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
    verify: { command: cmd, runs: 5 },
  });
  setStatus(state.runId, "watching");
  closeMailboxDone(state.runId);

  const result = waitMailbox(state.runId, { ceilingSec: 1, observe: false });
  assert.equal(result.classified.status, "failed");
  assert.match(result.classified.error, /parent verification failed/);
  assert.equal(loadState(state.runId).status, "failed");

  const report = JSON.parse(
    fs.readFileSync(path.join(runDir(state.runId), "mailbox", "VERIFICATION.json"), "utf8"),
  );
  assert.equal(report.verdict, "fail");
  assert.equal(report.runs.length, 5);
  assert.equal(report.runs[4].exitCode, 1);
  assert.equal(report.runs.slice(0, 4).every((r) => r.exitCode === 0), true);
}));

test("first run fails → fail verdict and all runs recorded", withTempRuns(async (runsRoot) => {
  const counter = path.join(runsRoot, "fail-first");
  fs.writeFileSync(counter, "0");
  const cmd = counterScript(counter, 1);
  const state = createRun({
    cwd: runsRoot,
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
    verify: { command: cmd, runs: 3 },
  });
  setStatus(state.runId, "watching");
  closeMailboxDone(state.runId);

  waitMailbox(state.runId, { ceilingSec: 1, observe: false });
  const report = JSON.parse(
    fs.readFileSync(path.join(runDir(state.runId), "mailbox", "VERIFICATION.json"), "utf8"),
  );
  assert.equal(report.verdict, "fail");
  assert.equal(report.runs.length, 3);
  assert.equal(report.runs[0].exitCode, 1);
}));

test("no verify → no VERIFICATION.json", withTempRuns(async () => {
  const state = createRun({
    cwd: "/tmp/p",
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
  });
  setStatus(state.runId, "watching");
  closeMailboxDone(state.runId);

  const result = waitMailbox(state.runId, { ceilingSec: 1, observe: false });
  assert.equal(result.classified.status, "done");
  assert.equal(
    fs.existsSync(path.join(runDir(state.runId), "mailbox", "VERIFICATION.json")),
    false,
  );
}));

test("worker-authored VERIFICATION.json is overwritten by parent", withTempRuns(async (runsRoot) => {
  const counter = path.join(runsRoot, "overwrite");
  fs.writeFileSync(counter, "0");
  const cmd = counterScript(counter, 999);
  const state = createRun({
    cwd: runsRoot,
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
    verify: { command: cmd, runs: 1 },
  });
  const mb = path.join(runDir(state.runId), "mailbox");
  atomicWriteJson(path.join(mb, "VERIFICATION.json"), {
    schema: "verification/1",
    verdict: "pass",
    runs: [{ n: 1, exitCode: 0 }],
    forged: true,
  });
  setStatus(state.runId, "watching");
  closeMailboxDone(state.runId);

  waitMailbox(state.runId, { ceilingSec: 1, observe: false });
  const report = JSON.parse(fs.readFileSync(path.join(mb, "VERIFICATION.json"), "utf8"));
  assert.equal(report.forged, undefined);
  assert.equal(report.verdict, "pass");
  assert.equal(report.command[0], process.execPath);
}));

test("unparseable output but exit 0 → pass verdict", withTempRuns(async (runsRoot) => {
  const cmd = [process.execPath, "-e", "console.log('no test summary here')"];
  const state = createRun({
    cwd: runsRoot,
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
    verify: { command: cmd, runs: 1 },
  });
  setStatus(state.runId, "watching");
  closeMailboxDone(state.runId);

  waitMailbox(state.runId, { ceilingSec: 1, observe: false });
  const report = JSON.parse(
    fs.readFileSync(path.join(runDir(state.runId), "mailbox", "VERIFICATION.json"), "utf8"),
  );
  assert.equal(report.verdict, "pass");
  assert.equal(report.runs[0].tests, undefined);
}));

test("runs wait CLI reports failed classification on verification failure", withTempRuns(async (runsRoot) => {
  const counter = path.join(runsRoot, "cli-fail");
  fs.writeFileSync(counter, "0");
  const cmd = counterScript(counter, 1);
  const state = createRun({
    cwd: runsRoot,
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
    verify: { command: cmd, runs: 1 },
  });
  setStatus(state.runId, "watching");
  closeMailboxDone(state.runId);

  const out = execFileSync(process.execPath, [RUNS_BIN, "wait", state.runId, "--ceiling-sec", "1"], {
    encoding: "utf8",
  });
  assert.match(out, /status: failed/);
}));

test("runs create --verify-command stores verify in STATE", withTempRuns(async (runsRoot) => {
  const promptFile = path.join(runsRoot, "prompt.md");
  fs.writeFileSync(promptFile, "do thing\n");
  const out = execFileSync(
    process.execPath,
    [
      RUNS_BIN,
      "create",
      "--cwd",
      runsRoot,
      "--role",
      "implementer",
      "--parent-cli",
      "claude",
      "--parent-attach",
      "manual",
      "--worker-cli",
      "codex",
      "--prompt-file",
      promptFile,
      "--verify-command",
      "npm test",
      "--verify-runs",
      "7",
    ],
    { encoding: "utf8" },
  );
  const runId = out.match(/^runId: (.+)$/m)[1];
  assert.deepEqual(loadState(runId).verify, { command: ["npm", "test"], runs: 7 });
}));

test("runParentVerification records commit and cwd", withTempRuns(async (runsRoot) => {
  const repoCwd = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const cmd = [process.execPath, "-e", "process.exit(0)"];
  const state = createRun({
    cwd: repoCwd,
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
    verify: { command: cmd, runs: 1 },
  });
  const loaded = loadState(state.runId);
  const report = runParentVerification(state.runId, loaded, {
    mailboxDir: (id) => path.join(runDir(id), "mailbox"),
    atomicWriteJson: (p, o) => fs.writeFileSync(p, `${JSON.stringify(o)}\n`),
  });
  assert.equal(report.cwd, repoCwd);
  assert.match(report.commit || "", /^[0-9a-f]{7,40}$/);
}));

// Verification ran on every reconcile of a done mailbox, unlocked: runs s4ji
// and 0pwq ended failed with a VERIFICATION.json saying pass, written by a
// second verifier that started before STATE was decided, and side-effecting
// commands (npm ci) ran again each time.
function verifiedRun(runsRoot, name, { runs = 2, failAt = 999 } = {}) {
  const counter = path.join(runsRoot, name);
  fs.writeFileSync(counter, "0");
  const state = createRun({
    cwd: runsRoot,
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
    verify: { command: counterScript(counter, failAt), runs },
  });
  setStatus(state.runId, "watching");
  closeMailboxDone(state.runId);
  return { runId: state.runId, count: () => Number(fs.readFileSync(counter, "utf8")) };
}

function verificationPath(runId) {
  return path.join(runDir(runId), "mailbox", "VERIFICATION.json");
}

function statusMtimeMs(runId) {
  return fs.statSync(path.join(runDir(runId), "mailbox", "STATUS")).mtimeMs;
}

test("a done is verified once: a second runs wait neither re-runs nor rewrites it", withTempRuns(async (runsRoot) => {
  const { runId, count } = verifiedRun(runsRoot, "once");
  assert.equal(waitMailbox(runId, { ceilingSec: 1, observe: false }).classified.status, "done");
  const first = fs.readFileSync(verificationPath(runId), "utf8");
  assert.equal(count(), 2);

  assert.equal(waitMailbox(runId, { ceilingSec: 1, observe: false }).classified.status, "done");
  assert.equal(count(), 2, "verify command ran again");
  assert.equal(fs.readFileSync(verificationPath(runId), "utf8"), first);
}));

function recordVerdict(runId, verdict, stamp) {
  updateState(runId, (s) => {
    s.verification = { verdict, status_mtime_ms: stamp, at: new Date().toISOString() };
    return s;
  });
}

test("an existing verdict for the same done is reused, not re-run", withTempRuns(async (runsRoot) => {
  const { runId, count } = verifiedRun(runsRoot, "reuse");
  // A verifier that recorded its verdict and died before the status was persisted.
  recordVerdict(runId, "fail", statusMtimeMs(runId));
  const r = waitMailbox(runId, { ceilingSec: 1, observe: false });
  assert.equal(r.classified.status, "failed");
  assert.equal(count(), 0);
  assert.equal(loadState(runId).status, "failed");
}));

test("a verdict stamped for another STATUS write is not reused", withTempRuns(async (runsRoot) => {
  const { runId, count } = verifiedRun(runsRoot, "stale-verdict");
  recordVerdict(runId, "fail", statusMtimeMs(runId) - 5000);
  assert.equal(waitMailbox(runId, { ceilingSec: 1, observe: false }).classified.status, "done");
  assert.equal(count(), 2);
  assert.equal(JSON.parse(fs.readFileSync(verificationPath(runId), "utf8")).status_mtime_ms, statusMtimeMs(runId));
  assert.equal(loadState(runId).verification.status_mtime_ms, statusMtimeMs(runId));
}));

// The worker can write its mailbox and stat its own STATUS: a stamped pass it
// planted there let the run be adopted done without the parent's command ever
// running. The verdict that counts is the one in STATE.
test("a worker-forged stamped verdict in the mailbox does not skip verification", withTempRuns(async (runsRoot) => {
  const { runId, count } = verifiedRun(runsRoot, "forged", { runs: 1, failAt: 1 });
  atomicWriteJson(verificationPath(runId), {
    schema: "verification/1", verdict: "pass", runs: [], status_mtime_ms: statusMtimeMs(runId),
  });
  assert.equal(waitMailbox(runId, { ceilingSec: 1, observe: false }).classified.status, "failed");
  assert.equal(count(), 1);
  assert.equal(loadState(runId).status, "failed");
  assert.equal(loadState(runId).verification.verdict, "fail");
}));

test("while another live verifier holds the lock, runs wait does not verify or decide", withTempRuns(async (runsRoot) => {
  const { runId, count } = verifiedRun(runsRoot, "busy");
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    fs.writeFileSync(path.join(runDir(runId), "mailbox", ".VERIFICATION.lock"), `${holder.pid}\n`);
    const r = waitMailbox(runId, { ceilingSec: 2, observe: false, stopTmux: () => assert.fail("killed the worker") });
    assert.equal(r.waitExit, 2);
    assert.equal(r.classified.status, "watching");
    assert.equal(count(), 0);
    assert.equal(loadState(runId).status, "watching");
  } finally {
    holder.kill();
  }
}));

test("a lock left behind by a dead verifier is taken over", withTempRuns(async (runsRoot) => {
  const { runId, count } = verifiedRun(runsRoot, "dead-holder");
  fs.writeFileSync(path.join(runDir(runId), "mailbox", ".VERIFICATION.lock"), "2147483646\n");
  assert.equal(waitMailbox(runId, { ceilingSec: 1, observe: false }).classified.status, "done");
  assert.equal(count(), 2);
  assert.equal(fs.existsSync(path.join(runDir(runId), "mailbox", ".VERIFICATION.lock")), false);
}));

// The lock named its holder by pid alone, and was created empty and written
// after: a second watcher could read "" (no holder) and take a live lock, or
// trust a pid the dead verifier's successor process now carries.
test("a lock whose pid now belongs to another process is taken over", withTempRuns(async (runsRoot) => {
  const { runId, count } = verifiedRun(runsRoot, "reused-pid");
  const other = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    fs.writeFileSync(path.join(runDir(runId), "mailbox", ".VERIFICATION.lock"), `${other.pid} 1\n`);
    assert.equal(waitMailbox(runId, { ceilingSec: 1, observe: false }).classified.status, "done");
    assert.equal(count(), 2);
  } finally {
    other.kill();
  }
}));

test("a lock still being written counts as held; an old empty one does not", withTempRuns(async (runsRoot) => {
  const { runId, count } = verifiedRun(runsRoot, "empty-lock");
  const lock = path.join(runDir(runId), "mailbox", ".VERIFICATION.lock");
  fs.writeFileSync(lock, "");
  const r = waitMailbox(runId, { ceilingSec: 1, observe: false, stopTmux: () => assert.fail("killed the worker") });
  assert.equal(r.waitExit, 2);
  assert.equal(count(), 0);

  const old = (Date.now() - 60_000) / 1000;
  fs.utimesSync(lock, old, old);
  assert.equal(waitMailbox(runId, { ceilingSec: 1, observe: false }).classified.status, "done");
  assert.equal(count(), 2);
}));

test("an acquired lock names its holder by pid and start time", withTempRuns(async (runsRoot) => {
  const mb = fs.mkdtempSync(path.join(runsRoot, "mb-"));
  const release = acquireVerificationLock(mb);
  const [pid, start] = fs.readFileSync(path.join(mb, ".VERIFICATION.lock"), "utf8").trim().split(" ");
  assert.equal(Number(pid), process.pid);
  assert.match(start, /^\d+$/);
  assert.equal(acquireVerificationLock(mb), null, "a live holder's lock was taken");
  release();
  assert.deepEqual(fs.readdirSync(mb), []);
}));

// A verify command with no timeout hung one watcher for three days inside
// `node --test`; its live pid kept the lock, so gc never adopted the done.
test("a verify command that outlives verify.timeout_sec fails with 'verify timed out'", withTempRuns(async (runsRoot) => {
  const state = createRun({
    cwd: runsRoot,
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
    verify: { command: ["bash", "-c", "sleep 5 & exec sleep 30"], runs: 3 },
  });
  const t0 = Date.now();
  const report = runParentVerification(state.runId, { ...loadState(state.runId), verify: { ...state.verify, timeout_sec: 1 } }, {
    mailboxDir: (id) => path.join(runDir(id), "mailbox"),
    atomicWriteJson,
  });
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
  assert.equal(report.verdict, "fail");
  assert.equal(report.reason, "verify timed out");
  assert.equal(report.runs.length, 1, "kept running after the budget was spent");
}));

test("a lock older than the verify timeout no longer holds, even with its pid alive", withTempRuns(async (runsRoot) => {
  const { runId, count } = verifiedRun(runsRoot, "hung-holder");
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const lock = path.join(runDir(runId), "mailbox", ".VERIFICATION.lock");
    fs.writeFileSync(lock, `${holder.pid}\n`);
    const old = (Date.now() - 2 * 3600_000) / 1000;
    fs.utimesSync(lock, old, old);
    assert.equal(waitMailbox(runId, { ceilingSec: 1, observe: false }).classified.status, "done");
    assert.equal(count(), 2);
  } finally {
    holder.kill();
  }
}));

// An unresolved gc stale claim keeps STATE non-terminal without deciding the
// run; resolveRunState reports no change there, which read as "decided" and
// handed the parent the done unverified.
test("a done under an open gc stale claim is still verified", withTempRuns(async (runsRoot) => {
  const { runId, count } = verifiedRun(runsRoot, "claim", { runs: 1, failAt: 1 });
  updateState(runId, (s) => {
    s.cleanup = {
      stale_publication_claim: { token: "t", phase: "claimed", worker_tmux: "x", claimed_at: new Date().toISOString() },
    };
    return s;
  });
  const r = waitMailbox(runId, { ceilingSec: 1, observe: false, stopTmux: () => {} });
  assert.equal(r.classified.status, "failed");
  assert.equal(count(), 1);
  assert.equal(loadState(runId).verification.verdict, "fail");
}));

// gc adopts a done when no watcher is attached, before anyone verified it.
// The later runs wait then saw a decided run and recorded nothing, so a red
// build reached intake as done with no evidence against it.
test("a done gc adopted unverified is verified once for the record, and stays done", withTempRuns(async (runsRoot) => {
  const { runId, count } = verifiedRun(runsRoot, "adopted", { runs: 1, failAt: 1 });
  gcRuns({
    states: [loadState(runId)],
    heartbeatFor: () => null,
    inspectTmux: () => ({ exists: false, activityMs: null, sessionId: null }),
    listSessions: () => [],
  });
  assert.equal(loadState(runId).status, "done");

  waitMailbox(runId, { ceilingSec: 1, observe: false, stopTmux: () => {} });
  assert.equal(count(), 1);
  assert.equal(JSON.parse(fs.readFileSync(verificationPath(runId), "utf8")).verdict, "fail");
  assert.equal(loadState(runId).verification.verdict, "fail");
  assert.equal(loadState(runId).status, "done");

  waitMailbox(runId, { ceilingSec: 1, observe: false, stopTmux: () => {} });
  assert.equal(count(), 1, "verified again");
}));

test("a run decided before verification never gets a VERIFICATION.json", withTempRuns(async (runsRoot) => {
  const { runId, count } = verifiedRun(runsRoot, "decided");
  setStatus(runId, "cancelled");
  closeMailboxDone(runId);
  waitMailbox(runId, { ceilingSec: 1, observe: false });
  assert.equal(count(), 0);
  assert.equal(fs.existsSync(verificationPath(runId)), false);
  assert.equal(loadState(runId).status, "cancelled");
}));
