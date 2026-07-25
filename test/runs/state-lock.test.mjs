import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRun } from "../../src/runs/runs.mjs";

const RUNS_MODULE = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/runs/runs.mjs"),
).href;

function withTempRuns(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-state-lock-"));
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

function fixture() {
  return createRun({
    cwd: "/tmp/project",
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "worker" },
    prompt: "test",
  });
}

function workerSource(body) {
  return `
import fs from "node:fs";
import { updateState } from ${JSON.stringify(RUNS_MODULE)};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
${body}
`;
}

function startWorker(body, env) {
  return spawn(process.execPath, ["--input-type=module", "-e", workerSource(body)], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForExit(child, timeoutMs = 3000) {
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`child ${child.pid} did not exit`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForText(filePath, pattern, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let text = "";
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      // Worker has not entered yet.
    }
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${pattern} in ${filePath}`);
}

test("two processes serialize STATE critical sections without overlap", withTempRuns(async (dir) => {
  const state = fixture();
  const logPath = path.join(dir, "critical.log");
  const first = startWorker(`
updateState(process.env.RUN_ID, (draft) => {
  fs.appendFileSync(process.env.LOG_PATH, "enter first\\n");
  sleep(250);
  fs.appendFileSync(process.env.LOG_PATH, "exit first\\n");
  draft.first = true;
  return draft;
});
`, { RUN_ID: state.runId, LOG_PATH: logPath });
  await waitForText(logPath, /enter first/);
  const second = startWorker(`
updateState(process.env.RUN_ID, (draft) => {
  fs.appendFileSync(process.env.LOG_PATH, "enter second\\n");
  fs.appendFileSync(process.env.LOG_PATH, "exit second\\n");
  draft.second = true;
  return draft;
});
`, { RUN_ID: state.runId, LOG_PATH: logPath });

  const [firstExit, secondExit] = await Promise.all([waitForExit(first), waitForExit(second)]);
  assert.deepEqual(firstExit, { code: 0, signal: null });
  assert.deepEqual(secondExit, { code: 0, signal: null });
  assert.deepEqual(
    fs.readFileSync(logPath, "utf8").trim().split("\n"),
    ["enter first", "exit first", "enter second", "exit second"],
  );
}));

test("killing a lock holder releases the OS lock for a waiter", withTempRuns(async (dir) => {
  const state = fixture();
  const enteredPath = path.join(dir, "holder-entered");
  const holder = startWorker(`
updateState(process.env.RUN_ID, (draft) => {
  fs.writeFileSync(process.env.ENTERED_PATH, "entered\\n");
  sleep(10_000);
  draft.holder = true;
  return draft;
});
`, { RUN_ID: state.runId, ENTERED_PATH: enteredPath });
  await waitForText(enteredPath, /entered/);
  holder.kill("SIGKILL");
  const holderExit = await waitForExit(holder);
  assert.equal(holderExit.signal, "SIGKILL");

  const waiter = startWorker(`
updateState(process.env.RUN_ID, (draft) => {
  draft.waiter = true;
  return draft;
}, { lockTimeoutMs: 1000 });
`, { RUN_ID: state.runId });
  assert.deepEqual(await waitForExit(waiter), { code: 0, signal: null });
  assert.deepEqual(
    fs.readdirSync(path.join(dir, state.runId)).filter((name) => name.endsWith(".acquired")),
    [],
  );
}));

test("STATE lock contention respects a bounded timeout", withTempRuns(async (dir) => {
  const state = fixture();
  const enteredPath = path.join(dir, "timeout-holder-entered");
  const resultPath = path.join(dir, "timeout-result.json");
  const holder = startWorker(`
updateState(process.env.RUN_ID, (draft) => {
  fs.writeFileSync(process.env.ENTERED_PATH, "entered\\n");
  sleep(500);
  draft.holder = true;
  return draft;
});
`, { RUN_ID: state.runId, ENTERED_PATH: enteredPath });
  await waitForText(enteredPath, /entered/);

  const waiter = startWorker(`
const started = Date.now();
try {
  updateState(process.env.RUN_ID, (draft) => draft, { lockTimeoutMs: 100 });
  fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({ acquired: true, elapsed: Date.now() - started }));
} catch (error) {
  fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({
    acquired: false,
    code: error.code,
    elapsed: Date.now() - started,
  }));
}
`, { RUN_ID: state.runId, RESULT_PATH: resultPath });
  assert.deepEqual(await waitForExit(waiter), { code: 0, signal: null });
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(result.acquired, false);
  assert.equal(result.code, "STATE_LOCK_BUSY");
  assert.ok(result.elapsed >= 80, `lock returned too early after ${result.elapsed}ms`);
  assert.ok(result.elapsed < 450, `lock exceeded its bound: ${result.elapsed}ms`);
  assert.deepEqual(await waitForExit(holder), { code: 0, signal: null });
}));
