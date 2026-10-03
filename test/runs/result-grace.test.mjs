// A worker that writes STATUS=done before its RESULT is still finishing.
// Live data: 12 cursor runs were failed 12-205 ms after STATUS=done, and 5
// more got their RESULT 2-54 s later but stayed failed — terminal is
// irreversible, and the worker's tmux was killed on the spot.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as runs from "../../src/runs/runs.mjs";

function withTempRuns(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-grace-"));
    const prev = process.env.TEAM_UP_RUNS;
    const prevO9k = process.env.O9K_RUNS;
    delete process.env.O9K_RUNS;
    process.env.TEAM_UP_RUNS = dir;
    try {
      await fn(dir);
    } finally {
      if (prev === undefined) delete process.env.TEAM_UP_RUNS;
      else process.env.TEAM_UP_RUNS = prev;
      if (prevO9k !== undefined) process.env.O9K_RUNS = prevO9k;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function doneRun({ typed = false } = {}) {
  const state = runs.createRun({
    cwd: "/tmp/p",
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "cursor", tmux: "worker-grace" },
    prompt: "x",
    ...(typed ? { result_protocol: "RESULT.json" } : {}),
  });
  runs.setStatus(state.runId, "watching");
  runs.atomicWriteText(path.join(runs.mailboxDir(state.runId), "STATUS"), "done");
  return state.runId;
}

function ageStatus(runId, ms) {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(path.join(runs.mailboxDir(runId), "STATUS"), t, t);
}

/** Write a mailbox file from another process while waitMailbox blocks this one. */
function writeLater(runId, name, body, delaySec = 1) {
  const target = path.join(runs.mailboxDir(runId), name);
  spawn("sh", ["-c", `sleep ${delaySec}; printf '%s' "$2" > "$1.tmp" && mv "$1.tmp" "$1"`, "sh", target, body], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

test("done without RESULT inside the grace window is pending, not failed", withTempRuns(async () => {
  const runId = doneRun();
  assert.deepEqual(runs.classifyMailbox(runId), { status: "watching", pending: "result" });
  const stopped = [];
  const r = runs.waitMailbox(runId, { ceilingSec: 1, observe: false, stopTmux: (s) => stopped.push(s) });
  assert.equal(r.waitExit, 2);
  assert.equal(r.classified.status, "watching");
  assert.equal(runs.loadState(runId).status, "watching");
  assert.deepEqual(stopped, [], "the worker must not be killed while its RESULT is due");
}));

test("a RESULT that lands inside the grace window makes the run done", withTempRuns(async () => {
  const runId = doneRun();
  writeLater(runId, "RESULT.md", "late but real\n");
  const stopped = [];
  const started = Date.now();
  const r = runs.waitMailbox(runId, { ceilingSec: 20, observe: false, stopTmux: (s) => stopped.push(s) });
  assert.equal(r.classified.status, "done");
  assert.equal(r.waitExit, 0);
  assert.ok(Date.now() - started < 10_000, "woke on the RESULT, not on the ceiling");
  assert.equal(runs.loadState(runId).status, "done");
  assert.deepEqual(stopped, ["worker-grace"]);
}));

test("past the grace window a missing RESULT fails the run with the old reason", withTempRuns(async () => {
  const runId = doneRun();
  ageStatus(runId, runs.RESULT_GRACE_MS + 1000);
  const r = runs.waitMailbox(runId, { ceilingSec: 5, observe: false, stopTmux: () => {} });
  assert.equal(r.classified.status, "failed");
  const state = runs.loadState(runId);
  assert.equal(state.status, "failed");
  assert.equal(state.failure.error, "STATUS=done but RESULT.md missing");
}));

test("the grace covers the slowest observed RESULT (54 s) with margin", () => {
  assert.ok(runs.RESULT_GRACE_MS >= 2 * 54_000);
});

test("typed run: no RESULT yet is pending until RESULT.json lands", withTempRuns(async () => {
  const runId = doneRun({ typed: true });
  assert.deepEqual(runs.classifyMailbox(runId), { status: "watching", pending: "result" });
  writeLater(runId, "RESULT.json", JSON.stringify({ schema: "team-up.result/v1", status: "success", summary: "ok" }));
  const started = Date.now();
  const r = runs.waitMailbox(runId, { ceilingSec: 20, observe: false, stopTmux: () => {} });
  assert.equal(r.classified.status, "done");
  assert.ok(Date.now() - started < 10_000);
}));

test("typed run that left only RESULT.md fails at once: it closed out with the wrong file", withTempRuns(async () => {
  const runId = doneRun({ typed: true });
  runs.atomicWriteText(path.join(runs.mailboxDir(runId), "RESULT.md"), "notes\n");
  const c = runs.classifyMailbox(runId);
  assert.equal(c.status, "failed");
  assert.match(c.error, /RESULT\.json missing/);
}));

test("typed run past the grace window keeps the typed failure", withTempRuns(async () => {
  const runId = doneRun({ typed: true });
  ageStatus(runId, runs.RESULT_GRACE_MS + 1000);
  const c = runs.classifyMailbox(runId);
  assert.equal(c.status, "failed");
  assert.match(c.error, /RESULT\.json missing/);
}));
