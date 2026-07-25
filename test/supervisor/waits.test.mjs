import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, loadState, runDir } from "../../src/runs/runs.mjs";
import {
  approveCapacityWait,
  cancelCapacityWait,
  listDueWaits,
} from "../../src/supervisor/waits.mjs";

test("approved wait survives restart and becomes due", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-waits-"));
  const prevRuns = process.env.TEAM_UP_RUNS;
  const prevHome = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_RUNS = path.join(home, "runs");
  process.env.TEAM_UP_HOME = home;
  try {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:x",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude" },
      prompt: "hi",
    });
    const runId = run.runId;
    approveCapacityWait({
      runId,
      nextResetAt: "2026-07-25T18:30:00Z",
      now: "2026-07-25T17:00:00Z",
    });
    assert.deepEqual(listDueWaits({ now: "2026-07-25T18:30:01Z" }), [runId]);
  } finally {
    if (prevRuns === undefined) delete process.env.TEAM_UP_RUNS;
    else process.env.TEAM_UP_RUNS = prevRuns;
    if (prevHome === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cancel wait preserves run and disables automatic resume", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-waits2-"));
  const prevRuns = process.env.TEAM_UP_RUNS;
  const prevHome = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_RUNS = path.join(home, "runs");
  process.env.TEAM_UP_HOME = home;
  try {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:x",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude" },
      prompt: "hi",
    });
    const runId = run.runId;
    approveCapacityWait({
      runId,
      nextResetAt: "2026-07-25T18:30:00Z",
      now: "2026-07-25T17:00:00Z",
    });
    cancelCapacityWait({ runId, reason: "human requested" });
    const state = loadState(runId);
    assert.equal(state.status, "waiting_decision");
    assert.equal(state.capacity.auto_resume, false);
    assert.equal(fs.existsSync(runDir(runId)), true);
  } finally {
    if (prevRuns === undefined) delete process.env.TEAM_UP_RUNS;
    else process.env.TEAM_UP_RUNS = prevRuns;
    if (prevHome === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
