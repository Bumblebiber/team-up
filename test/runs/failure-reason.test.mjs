import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    plant(home, "20260101T000000Z-r001", "done"); // done without RESULT.md
    // ...and long enough ago that the RESULT is no longer due.
    const old = (Date.now() - runs.RESULT_GRACE_MS - 1000) / 1000;
    fs.utimesSync(path.join(home, "runs", "20260101T000000Z-r001", "mailbox", "STATUS"), old, old);
    runs.waitMailbox("20260101T000000Z-r001", { observe: false, stopTmux: () => {} });
    const state = runs.loadState("20260101T000000Z-r001");
    assert.equal(state.status, "failed");
    assert.equal(state.failure.error, "STATUS=done but RESULT.md missing");
    assert.match(state.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("setStatus records a reason only for failures, and never overwrites the first", async () => {
  await withHome(({ home, runs }) => {
    plant(home, "20260101T000000Z-r001", "");
    runs.setStatus("20260101T000000Z-r001", "watching", { reason: "ignored" });
    assert.equal(runs.loadState("20260101T000000Z-r001").failure, undefined);
    assert.equal(runs.loadState("20260101T000000Z-r001").finishedAt, undefined);
    runs.setStatus("20260101T000000Z-r001", "failed", { reason: "capsule setup: boom" });
    runs.setStatus("20260101T000000Z-r001", "failed", { reason: "later" });
    assert.equal(runs.loadState("20260101T000000Z-r001").failure.error, "capsule setup: boom");
  });
});

test("a run that leaves failed for done drops the failure and re-stamps its end", async () => {
  await withHome(({ home, runs }) => {
    plant(home, "20260101T000000Z-r001", "");
    runs.setStatus("20260101T000000Z-r001", "failed", { reason: "worker deadline exceeded" });
    const staleEnd = runs.loadState("20260101T000000Z-r001").finishedAt;
    runs.updateState("20260101T000000Z-r001", (s) => ({ ...s, status: "watching" }));
    assert.equal(runs.loadState("20260101T000000Z-r001").finishedAt, undefined);
    assert.equal(runs.loadState("20260101T000000Z-r001").failure, undefined);
    runs.setStatus("20260101T000000Z-r001", "done");
    const state = runs.loadState("20260101T000000Z-r001");
    assert.equal(state.failure, undefined);
    assert.ok(state.finishedAt >= staleEnd);
  });
});

test("a retryable failure from a handoff does not shadow the terminal reason", async () => {
  await withHome(({ home, runs }) => {
    plant(home, "20260101T000000Z-r001", "");
    runs.updateState("20260101T000000Z-r001", (s) => ({ ...s, status: "handing_off", failure: { type: "usage_refresh_failed", retryable: true, error: "USAGE_REFRESH_FAILED" } }));
    runs.setStatus("20260101T000000Z-r001", "failed", { reason: "capsule setup: boom" });
    assert.equal(runs.loadState("20260101T000000Z-r001").failure.error, "capsule setup: boom");
  });
});

test("a done run in a git cwd records the commit it ended on", async () => {
  await withHome(({ home, runs }) => {
    plant(home, "20260101T000000Z-r001", "");
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tu-head-"));
    try {
      const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
      execFileSync("git", ["-C", repo, "init", "-q"], { env });
      execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "x"], { env });
      const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      runs.updateState("20260101T000000Z-r001", (s) => ({ ...s, cwd: repo, base_commit: "0000" }));
      runs.setStatus("20260101T000000Z-r001", "done");
      assert.equal(runs.loadState("20260101T000000Z-r001").head_commit, head);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
