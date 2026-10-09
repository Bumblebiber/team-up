import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicWriteText, createRun as createRunRecord, mailboxDir } from "../../src/runs/runs.mjs";
import { descendantPids, signalWorker } from "../../src/runs/headless.mjs";

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

function agyResultCode(result, conversationId = "agy-conversation-1") {
  const init = { event: "init", conversation_id: conversationId };
  const final = { event: "result", result: { conversation_id: conversationId, ...result } };
  return `console.log(${JSON.stringify(JSON.stringify(init))}); console.log(${JSON.stringify(JSON.stringify(final))});`;
}

function agyFixtureCode() {
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/agy-stream-json-result.ndjson");
  const lines = fs.readFileSync(fixturePath, "utf8").trim().split(/\r?\n/);
  return `for (const line of ${JSON.stringify(lines)}) console.log(line);`;
}

test("descendantPids walks the whole tree, including tools that left the group", () => {
  const ps = () => " 10 1\n 20 10\n 30 20\n 31 20\n 40 1\n 50 30\n";
  assert.deepEqual(descendantPids(10, { ps }).sort((a, b) => a - b), [20, 30, 31, 50]);
  assert.deepEqual(descendantPids(40, { ps }), []);
});

test("timeout signaling targets detached worker process group", () => {
  const calls = [];
  signalWorker({ pid: 123, kill: () => assert.fail("group kill should be used") }, "SIGTERM", {
    platform: "linux",
    kill: (pid, signal) => calls.push([pid, signal]),
  });
  assert.deepEqual(calls, [[-123, "SIGTERM"]]);
});

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

test("headless fills RESULT.md for a worker that set done without one", withTempRuns(async () => {
  const state = createRun();
  atomicWriteText(mailboxFile(state.runId, "STATUS"), "done");
  const resultPath = mailboxFile(state.runId, "LAST_MESSAGE.md");
  runHeadless(state.runId, { code: codexSuccessCode("forgot the file"), args: [resultPath] });
  assert.equal(mailboxText(state.runId, "STATUS").trim(), "done");
  assert.equal(mailboxText(state.runId, "RESULT.md").trim(), "forgot the file");
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

test("headless extracts agy final response and conversation id from stream-json", withTempRuns(async () => {
  const state = createRun();
  const result = runHeadless(state.runId, {
    cli: "agy",
    code: agyFixtureCode(),
  });
  assert.equal(result.status, 0);
  assert.equal(mailboxText(state.runId, "RESULT.md").trim(), "agy answer");
  assert.equal(mailboxText(state.runId, "SESSION_ID").trim(), "agy-conversation-1");
  assert.equal(mailboxText(state.runId, "STATUS").trim(), "done");
}));

test("headless uses the last agy result event", withTempRuns(async () => {
  const state = createRun();
  const early = JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "partial" } });
  const late = JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "final" } });
  const result = runHeadless(state.runId, {
    cli: "agy",
    code: `console.log(${JSON.stringify(early)}); console.log(${JSON.stringify(late)});`,
  });
  assert.equal(result.status, 0);
  assert.equal(mailboxText(state.runId, "RESULT.md").trim(), "final");
}));

test("headless fails agy empty responses and names soft-denied actions", withTempRuns(async () => {
  const empty = createRun();
  runHeadless(empty.runId, { cli: "agy", code: agyResultCode({ status: "SUCCESS", response: "" }) });
  assert.equal(mailboxText(empty.runId, "STATUS").trim(), "failed");
  assert.match(mailboxText(empty.runId, "FAILURE.md"), /agy returned an empty response/);

  const denied = createRun();
  runHeadless(denied.runId, {
    cli: "agy",
    code: agyResultCode({ status: "SUCCESS", response: "partial", denied_actions: [{ action: "command" }] }),
  });
  assert.equal(mailboxText(denied.runId, "STATUS").trim(), "failed");
  assert.match(mailboxText(denied.runId, "FAILURE.md"), /agy denied actions: command/);

  const errored = createRun();
  runHeadless(errored.runId, {
    cli: "agy",
    code: agyResultCode({ status: "ERROR", response: "", error: "invalid model selection" }),
  });
  assert.equal(mailboxText(errored.runId, "STATUS").trim(), "failed");
  assert.match(mailboxText(errored.runId, "FAILURE.md"), /agy error: invalid model selection/);
}));
