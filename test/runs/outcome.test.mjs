import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `status` says how a run ended, never whether the work was kept. Without that
 * second fact, no comparison between models, CLIs or launch paths can be more
 * than an anecdote.
 */
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-outcome-"));
  const prior = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  return import("../../src/runs/runs.mjs")
    .then((runs) => fn({ home, runs }))
    .finally(() => {
      if (prior === undefined) delete process.env.TEAM_UP_HOME;
      else process.env.TEAM_UP_HOME = prior;
      fs.rmSync(home, { recursive: true, force: true });
    });
}

function plant(home, runId, role, status = "done") {
  const dir = path.join(home, "runs", runId);
  fs.mkdirSync(path.join(dir, "mailbox"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "STATE.json"),
    JSON.stringify({ runId, version: 1, role, status, _stateRevision: 1 })
  );
  return dir;
}

test("an outcome is recorded beside the status, without touching it", async () => {
  await withHome(({ home, runs }) => {
    plant(home, "r-1", "implementer");
    const state = runs.setOutcome("r-1", "merged", { note: "landed as abc1234" });
    assert.equal(state.outcome.value, "merged");
    assert.equal(state.outcome.note, "landed as abc1234");
    assert.match(state.outcome.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(state.status, "done", "status is how it ended, outcome is what it was worth");
    // It survives a reload, which is the whole point of writing it down.
    assert.equal(runs.loadState("r-1").outcome.value, "merged");
    // And it can be corrected later.
    assert.equal(runs.setOutcome("r-1", "discarded").outcome.value, "discarded");
  });
});

test("only the two known values are accepted", async () => {
  await withHome(({ home, runs }) => {
    plant(home, "r-1", "implementer");
    assert.throws(() => runs.setOutcome("r-1", "kinda"), /unknown outcome kinda/);
    assert.throws(() => runs.setOutcome("r-1", "success"), /merged\|discarded/);
    assert.equal(runs.loadState("r-1").outcome, undefined);
    assert.throws(() => runs.setOutcome("missing", "merged"), /unknown run missing/);
  });
});

test("the summary counts per role and names what is not recorded yet", async () => {
  await withHome(({ home, runs }) => {
    plant(home, "r-1", "implementer");
    plant(home, "r-2", "implementer");
    plant(home, "r-3", "implementer");
    plant(home, "r-4", "reviewer");
    runs.setOutcome("r-1", "merged");
    runs.setOutcome("r-2", "discarded");
    const [first, second] = runs.outcomeSummary();
    assert.deepEqual(first, {
      role: "implementer", merged: 1, discarded: 1, unrecorded: 1, total: 3,
    });
    assert.deepEqual(second, {
      role: "reviewer", merged: 0, discarded: 0, unrecorded: 1, total: 1,
    });
  });
});
