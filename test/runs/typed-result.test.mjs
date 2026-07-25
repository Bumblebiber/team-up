import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, writeTypedResult, classifyMailbox, runDir } from "../../src/runs/runs.mjs";

function withTempRuns(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-typed-"));
    const prev = process.env.TEAM_UP_RUNS || process.env.O9K_RUNS;
    process.env.TEAM_UP_RUNS = dir;
    try { await fn(dir); }
    finally {
      if (prev === undefined) { delete process.env.TEAM_UP_RUNS; delete process.env.O9K_RUNS; }
      else process.env.TEAM_UP_RUNS = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("typed result success classifies done", withTempRuns(async () => {
  const s = createRun({
    cwd: "/tmp/p", role: "specialist:testing.hannes",
    parent: { cli: "team-up", attach: "manual" },
    worker: { cli: "codex", model: "m" },
    prompt: "x",
  });
  const { classified } = writeTypedResult(s.runId, {
    status: "success",
    summary: "ok",
    runtime: { cli: "codex", model: "m", effort: "xhigh" },
  });
  assert.equal(classified.status, "done");
  assert.ok(fs.existsSync(path.join(runDir(s.runId), "mailbox", "RESULT.json")));
}));

test("malformed result becomes failed", withTempRuns(async () => {
  const s = createRun({
    cwd: "/tmp/p", role: "specialist:x",
    parent: { cli: "team-up", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
  });
  const { validated, classified } = writeTypedResult(s.runId, { status: "done-ish" });
  assert.equal(validated.status, "failed");
  assert.equal(classified.status, "failed");
  assert.match(validated.validation_error, /status/);
}));
