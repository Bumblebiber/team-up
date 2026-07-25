import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, loadState } from "../src/runs/runs.mjs";
import { approveCapacityWait, cancelCapacityWait } from "../src/supervisor/waits.mjs";
import { runCli } from "../src/cli.mjs";

test("cli cancel-wait keeps run files and disables auto resume", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-cli-wait-"));
  const prevRuns = process.env.TEAM_UP_RUNS;
  const prevHome = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_RUNS = path.join(home, "runs");
  process.env.TEAM_UP_HOME = home;
  const lines = [];
  try {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:x",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude" },
      prompt: "hi",
    });
    approveCapacityWait({
      runId: run.runId,
      nextResetAt: "2026-07-25T18:30:00Z",
    });
    const code = await runCli(
      ["runs", "cancel-wait", run.runId, "--reason", "human requested"],
      { out: (s) => lines.push(String(s)), err: (s) => lines.push(String(s)) }
    );
    assert.equal(code, 0);
    const state = loadState(run.runId);
    assert.equal(state.capacity.auto_resume, false);
    assert.equal(state.status, "waiting_decision");
  } finally {
    if (prevRuns === undefined) delete process.env.TEAM_UP_RUNS;
    else process.env.TEAM_UP_RUNS = prevRuns;
    if (prevHome === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
