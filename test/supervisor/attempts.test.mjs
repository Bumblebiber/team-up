import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun } from "../../src/runs/runs.mjs";
import {
  acquireAttemptLease,
  createAttempt,
  releaseAttemptLease,
} from "../../src/supervisor/attempts.mjs";

test("only expected predecessor can acquire the next lease", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-attempts-"));
  const prev = process.env.TEAM_UP_RUNS;
  process.env.TEAM_UP_RUNS = home;
  try {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:x",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "a" },
      prompt: "hi",
    });
    const runId = run.runId;
    const first = createAttempt({ runId, runtime: { cli: "claude", model: "a" } });
    assert.equal(acquireAttemptLease({ runId, attemptId: first.id, expectedPrevious: null }).ok, true);
    const second = createAttempt({ runId, runtime: { cli: "claude", model: "b" } });
    assert.equal(acquireAttemptLease({ runId, attemptId: second.id, expectedPrevious: "wrong" }).ok, false);
    releaseAttemptLease({ runId, attemptId: first.id, reason: "handoff" });
    assert.equal(acquireAttemptLease({ runId, attemptId: second.id, expectedPrevious: first.id }).ok, true);
  } finally {
    if (prev === undefined) delete process.env.TEAM_UP_RUNS;
    else process.env.TEAM_UP_RUNS = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
