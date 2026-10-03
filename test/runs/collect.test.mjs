import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findUncollectedRuns } from "../../src/runs/collect.mjs";

const NOW = Date.parse("2026-10-01T12:00:00Z");

function plant(root, runId, state) {
  fs.mkdirSync(path.join(root, runId, "mailbox"), { recursive: true });
  fs.writeFileSync(path.join(root, runId, "STATE.json"),
    JSON.stringify({ runId, version: 1, _stateRevision: 1, ...state }));
}

test("uncollected lists finished, unread results inside the window", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-collect-"));
  plant(root, "a-done", { status: "done", role: "specialist:coding.codey", finishedAt: "2026-09-30T12:00:00Z" });
  fs.writeFileSync(path.join(root, "a-done", "mailbox", "RESULT.json"), "{}");
  plant(root, "b-failed", { status: "failed", finishedAt: "2026-09-29T12:00:00Z" });
  plant(root, "c-collected", { status: "done", finishedAt: "2026-09-30T12:00:00Z", collected: { at: "x" } });
  plant(root, "d-running", { status: "watching" });
  plant(root, "e-cancelled", { status: "cancelled", finishedAt: "2026-09-30T12:00:00Z" });
  plant(root, "f-old", { status: "done", finishedAt: "2026-08-01T12:00:00Z" });

  const runs = findUncollectedRuns({ root, now: NOW });
  assert.deepEqual(runs.map((r) => r.runId), ["a-done", "b-failed"]);
  assert.match(runs[0].result, /a-done\/mailbox\/RESULT\.json$/);
  assert.equal(runs[1].result, null);
  assert.deepEqual(findUncollectedRuns({ root, now: NOW, days: null }).map((r) => r.runId),
    ["a-done", "b-failed", "f-old"]);
});

test("collect marks a finished run and refuses a running one", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-collect-home-"));
  const prior = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    const runs = await import("../../src/runs/runs.mjs");
    const root = path.join(home, "runs");
    plant(root, "20260101T000000Z-done", { status: "done", finishedAt: new Date().toISOString() });
    plant(root, "20260101T000000Z-live", { status: "watching" });
    assert.equal(findUncollectedRuns({ root }).length, 1);
    const state = runs.markCollected("20260101T000000Z-done", { note: "merged", now: () => "2026-10-01T00:00:00Z" });
    assert.deepEqual(state.collected, { at: "2026-10-01T00:00:00Z", note: "merged" });
    assert.equal(findUncollectedRuns({ root }).length, 0);
    assert.throws(() => runs.markCollected("20260101T000000Z-live"), /only a finished run/);
  } finally {
    if (prior === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prior;
  }
});
