import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicWriteText, createRun as createRunRecord, mailboxDir } from "../../src/runs/runs.mjs";

const HEADLESS = fileURLToPath(new URL("../../src/runs/headless.mjs", import.meta.url));

function withTempRuns(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-headless-"));
    const previous = process.env.TEAM_UP_RUNS;
    process.env.TEAM_UP_RUNS = dir;
    try {
      await fn(dir);
    } finally {
      if (previous === undefined) delete process.env.TEAM_UP_RUNS;
      else process.env.TEAM_UP_RUNS = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function createRun({ result_protocol } = {}) {
  return createRunRecord({
    cwd: process.cwd(),
    role: "test",
    parent: { cli: "test", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "test headless wrapper",
    ...(result_protocol ? { result_protocol } : {}),
  });
}

function runHeadless(runId, { cli = "codex", code = "process.exit(0)", args = [] } = {}) {
  return spawnSync(process.execPath, [
    HEADLESS,
    runId,
    cli,
    "--",
    process.execPath,
    "-e",
    code,
    ...args,
  ], {
    encoding: "utf8",
    env: { ...process.env, TEAM_UP_RUNS: process.env.TEAM_UP_RUNS },
    maxBuffer: 1024 * 1024,
  });
}

function mailboxFile(runId, name) {
  return path.join(mailboxDir(runId), name);
}

function mailboxText(runId, name) {
  return fs.readFileSync(mailboxFile(runId, name), "utf8");
}

function workerStartLine() {
  return JSON.stringify({ type: "thread.started", thread_id: "thr-test-1" });
}

function codexSuccessCode(message = "final message") {
  return `const fs = require("node:fs"); fs.writeFileSync(process.argv[1], ${JSON.stringify(message)}); console.log(${JSON.stringify(workerStartLine())});`;
}

test("headless leaves an already terminal mailbox untouched", withTempRuns(async () => {
  const state = createRun();
  atomicWriteText(mailboxFile(state.runId, "STATUS"), "done");
  atomicWriteText(mailboxFile(state.runId, "RESULT.md"), "parent result");
  const resultPath = mailboxFile(state.runId, "LAST_MESSAGE.md");
  const result = runHeadless(state.runId, { code: codexSuccessCode("child result"), args: [resultPath] });
  assert.equal(result.status, 0);
  assert.equal(mailboxText(state.runId, "STATUS").trim(), "done");
  assert.equal(mailboxText(state.runId, "RESULT.md").trim(), "parent result");
}));

test("headless copies codex last message, records session id, heartbeat, and done", withTempRuns(async () => {
  const state = createRun();
  const resultPath = mailboxFile(state.runId, "LAST_MESSAGE.md");
  const result = runHeadless(state.runId, { code: codexSuccessCode("codex answer"), args: [resultPath] });
  assert.equal(result.status, 0);
  assert.equal(mailboxText(state.runId, "RESULT.md").trim(), "codex answer");
  assert.equal(mailboxText(state.runId, "STATUS").trim(), "done");
  assert.equal(mailboxText(state.runId, "SESSION_ID").trim(), "thr-test-1");
  assert.ok(Number.isFinite(Date.parse(mailboxText(state.runId, "HEARTBEAT").trim())));
}));

test("headless fails clean exit without final message", withTempRuns(async () => {
  const state = createRun();
  const result = runHeadless(state.runId, { code: `console.log(${JSON.stringify(workerStartLine())});` });
  assert.equal(result.status, 0);
  assert.equal(mailboxText(state.runId, "STATUS").trim(), "failed");
  assert.match(mailboxText(state.runId, "FAILURE.md"), /worker exited with code 0/);
}));

test("headless fails clean exit with an empty last message", withTempRuns(async () => {
  const state = createRun();
  const resultPath = mailboxFile(state.runId, "LAST_MESSAGE.md");
  const result = runHeadless(state.runId, { code: codexSuccessCode("  \n"), args: [resultPath] });
  assert.equal(result.status, 0);
  assert.equal(mailboxText(state.runId, "STATUS").trim(), "failed");
  assert.equal(fs.existsSync(mailboxFile(state.runId, "RESULT.md")), false);
}));

test("headless failure includes only last 40 stderr lines", withTempRuns(async () => {
  const state = createRun();
  const code = `for (let i = 0; i < 50; i++) console.error("line-" + i); process.exit(3);`;
  const result = runHeadless(state.runId, { code });
  assert.equal(result.status, 3);
  assert.equal(mailboxText(state.runId, "STATUS").trim(), "failed");
  const failure = mailboxText(state.runId, "FAILURE.md");
  assert.match(failure, /worker exited with code 3/);
  assert.match(failure, /line-10/);
  assert.match(failure, /line-49/);
  assert.doesNotMatch(failure, /line-9\n/);
}));

test("headless fails a worker that exits while waiting for a human", withTempRuns(async () => {
  const state = createRun();
  atomicWriteText(mailboxFile(state.runId, "STATUS"), "waiting_human");
  atomicWriteText(mailboxFile(state.runId, "QUESTIONS.md"), "Which database?\n");
  const result = runHeadless(state.runId);
  assert.equal(result.status, 0);
  assert.equal(mailboxText(state.runId, "STATUS").trim(), "failed");
  assert.match(mailboxText(state.runId, "FAILURE.md"), /headless runs cannot take answers/);
  assert.match(mailboxText(state.runId, "FAILURE.md"), /Which database\?/);
}));

test("headless fails typed runs without RESULT.json", withTempRuns(async () => {
  const state = createRun({ result_protocol: "RESULT.json" });
  const resultPath = mailboxFile(state.runId, "LAST_MESSAGE.md");
  const result = runHeadless(state.runId, { code: codexSuccessCode("not typed result"), args: [resultPath] });
  assert.equal(result.status, 0);
  assert.equal(mailboxText(state.runId, "STATUS").trim(), "failed");
  assert.match(mailboxText(state.runId, "FAILURE.md"), /typed run exited without RESULT.json/);
  assert.equal(fs.existsSync(mailboxFile(state.runId, "RESULT.json")), false);
}));

test("headless extracts cursor result text and session id", withTempRuns(async () => {
  const state = createRun();
  const event = JSON.stringify({ type: "result", is_error: false, result: "cursor answer", session_id: "cursor-test-1" });
  const result = runHeadless(state.runId, {
    cli: "cursor",
    code: `console.log(${JSON.stringify(event)});`,
  });
  assert.equal(result.status, 0);
  assert.equal(mailboxText(state.runId, "RESULT.md").trim(), "cursor answer");
  assert.equal(mailboxText(state.runId, "SESSION_ID").trim(), "cursor-test-1");
  assert.equal(mailboxText(state.runId, "STATUS").trim(), "done");
}));
