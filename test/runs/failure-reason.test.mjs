import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A failed run must say why. Before this, the classifier knew the reason and
 * dropped it on the way to STATE.json — 39 of 39 failed runs carried none.
 */
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-failure-"));
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

function plant(home, runId, status) {
  const dir = path.join(home, "runs", runId);
  fs.mkdirSync(path.join(dir, "mailbox"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "STATE.json"),
    JSON.stringify({ runId, version: 1, role: "implementer", status: "watching", _stateRevision: 1 })
  );
  fs.writeFileSync(path.join(dir, "mailbox", "STATUS"), status);
}

test("a mailbox that fails persists its reason and end time", async () => {
  await withHome(({ home, runs }) => {
    plant(home, "r-1", "done"); // done without RESULT.md
    runs.waitMailbox("r-1", { observe: false, stopTmux: () => {} });
    const state = runs.loadState("r-1");
    assert.equal(state.status, "failed");
    assert.equal(state.failure.error, "STATUS=done but RESULT.md missing");
    assert.match(state.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("setStatus records a reason only for failures, and never overwrites the first", async () => {
  await withHome(({ home, runs }) => {
    plant(home, "r-1", "");
    runs.setStatus("r-1", "watching", { reason: "ignored" });
    assert.equal(runs.loadState("r-1").failure, undefined);
    assert.equal(runs.loadState("r-1").finishedAt, undefined);
    runs.setStatus("r-1", "failed", { reason: "capsule setup: boom" });
    runs.setStatus("r-1", "failed", { reason: "later" });
    assert.equal(runs.loadState("r-1").failure.error, "capsule setup: boom");
  });
});

test("a run that leaves failed for done drops the failure and re-stamps its end", async () => {
  await withHome(({ home, runs }) => {
    plant(home, "r-1", "");
    runs.setStatus("r-1", "failed", { reason: "worker_stale_timeout" });
    const staleEnd = runs.loadState("r-1").finishedAt;
    runs.updateState("r-1", (s) => ({ ...s, status: "watching" }));
    assert.equal(runs.loadState("r-1").finishedAt, undefined);
    assert.equal(runs.loadState("r-1").failure, undefined);
    runs.setStatus("r-1", "done");
    const state = runs.loadState("r-1");
    assert.equal(state.failure, undefined);
    assert.ok(state.finishedAt >= staleEnd);
  });
});

test("a retryable failure from a handoff does not shadow the terminal reason", async () => {
  await withHome(({ home, runs }) => {
    plant(home, "r-1", "");
    runs.updateState("r-1", (s) => ({ ...s, status: "handing_off", failure: { type: "usage_refresh_failed", retryable: true, error: "USAGE_REFRESH_FAILED" } }));
    runs.setStatus("r-1", "failed", { reason: "capsule setup: boom" });
    assert.equal(runs.loadState("r-1").failure.error, "capsule setup: boom");
  });
});
