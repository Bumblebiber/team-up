import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, classifyMailbox, setStatus, runDir, atomicWriteText } from "../../src/runs/runs.mjs";
import { atomicWriteJson } from "../../src/json-store.mjs";

function withTempRuns(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-json-mb-"));
    const prev = process.env.TEAM_UP_RUNS;
    process.env.TEAM_UP_RUNS = dir;
    try { await fn(dir); }
    finally {
      if (prev === undefined) delete process.env.TEAM_UP_RUNS;
      else process.env.TEAM_UP_RUNS = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("RESULT.md alone with STATUS=done is not success", withTempRuns(async () => {
  const s = createRun({
    cwd: "/tmp/p", role: "specialist:x",
    parent: { cli: "team-up", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
  });
  const mb = path.join(runDir(s.runId), "mailbox");
  atomicWriteText(path.join(mb, "RESULT.md"), "# ok\n");
  setStatus(s.runId, "done");
  const c = classifyMailbox(s.runId);
  assert.equal(c.status, "failed");
  assert.match(c.error, /RESULT\.json/);
}));

test("valid RESULT.json classifies done", withTempRuns(async () => {
  const s = createRun({
    cwd: "/tmp/p", role: "specialist:x",
    parent: { cli: "team-up", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
  });
  const mb = path.join(runDir(s.runId), "mailbox");
  atomicWriteJson(path.join(mb, "RESULT.json"), {
    schema: "team-up.result/v1",
    status: "success",
    summary: "ok",
  });
  setStatus(s.runId, "done");
  const c = classifyMailbox(s.runId);
  assert.equal(c.status, "done");
  assert.match(c.resultPath, /RESULT\.json$/);
}));
