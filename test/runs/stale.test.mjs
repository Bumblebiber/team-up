import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findStaleRuns, findOrphanSessions, DEFAULT_THRESHOLD_MS } from "../../src/runs/stale.mjs";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-08-29T12:00:00Z");

function runsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tu-stale-"));
}

function plant(root, runId, { status, session = null, heartbeatAgeMs = null }) {
  const dir = path.join(root, runId);
  fs.mkdirSync(path.join(dir, "mailbox"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "STATE.json"),
    JSON.stringify({ runId, status, ...(session ? { worker: { tmux: session } } : {}) })
  );
  if (heartbeatAgeMs !== null) {
    const hb = path.join(dir, "mailbox", "HEARTBEAT");
    fs.writeFileSync(hb, "beat\n");
    const when = new Date(NOW - heartbeatAgeMs);
    fs.utimesSync(hb, when, when);
  }
  return dir;
}

const alwaysAlive = () => true;
const neverAlive = () => false;

test("a finished run is never stale, however old", () => {
  const root = runsRoot();
  for (const status of ["done", "failed", "cancelled"]) {
    plant(root, `r-${status}`, { status, heartbeatAgeMs: 900 * HOUR });
  }
  assert.deepEqual(findStaleRuns({ root, now: NOW, sessionAlive: neverAlive }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a working run with a live terminal and a fresh mailbox is not reported", () => {
  const root = runsRoot();
  plant(root, "r-busy", { status: "watching", session: "team-up-x", heartbeatAgeMs: 2 * HOUR });
  assert.deepEqual(findStaleRuns({ root, now: NOW, sessionAlive: alwaysAlive }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a run whose terminal is gone is reported even while recently alive", () => {
  // This is the shape gc skips forever: it only reaps active runs that still
  // have a session, so a run whose terminal died is invisible to it.
  const root = runsRoot();
  plant(root, "r-lost", { status: "watching", session: "team-up-x", heartbeatAgeMs: 1 * HOUR });
  const [found] = findStaleRuns({ root, now: NOW, sessionAlive: neverAlive });
  assert.equal(found.runId, "r-lost");
  assert.deepEqual(found.reasons, ["terminal is gone"]);
  assert.equal(found.silent_hours, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a protected run is reported, which is the whole point", () => {
  // waiting_human is in gc's PROTECTED set on purpose — a person may take days.
  // Nothing bounds it, so one sat asking whether a session was alive for 31
  // days. Reporting needs no policy about when someone stops coming back.
  const root = runsRoot();
  plant(root, "r-asking", {
    status: "waiting_human",
    session: "team-up-x",
    heartbeatAgeMs: 744 * HOUR,
  });
  const [found] = findStaleRuns({ root, now: NOW, sessionAlive: neverAlive });
  assert.equal(found.status, "waiting_human");
  assert.deepEqual(found.reasons, ["terminal is gone", "mailbox silent"]);
  assert.equal(found.silent_hours, 744);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a run that never got a terminal or a heartbeat says both", () => {
  const root = runsRoot();
  plant(root, "r-stillborn", { status: "starting" });
  const [found] = findStaleRuns({ root, now: NOW, sessionAlive: neverAlive });
  assert.deepEqual(found.reasons, ["never got a terminal", "no heartbeat was ever written"]);
  assert.equal(found.silent_hours, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a live terminal with a silent mailbox is reported past the threshold only", () => {
  const root = runsRoot();
  plant(root, "r-quiet", { status: "watching", session: "team-up-x", heartbeatAgeMs: 7 * HOUR });
  assert.equal(findStaleRuns({ root, now: NOW, sessionAlive: alwaysAlive }).length, 1);
  assert.equal(
    findStaleRuns({ root, now: NOW, sessionAlive: alwaysAlive, thresholdMs: 12 * HOUR }).length,
    0
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("a directory that is not a run is skipped, not reported", () => {
  const root = runsRoot();
  fs.mkdirSync(path.join(root, "not-a-run"));
  fs.mkdirSync(path.join(root, "broken"));
  fs.writeFileSync(path.join(root, "broken", "STATE.json"), "{ truncated");
  assert.deepEqual(findStaleRuns({ root, now: NOW, sessionAlive: neverAlive }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the default threshold is six hours", () => {
  assert.equal(DEFAULT_THRESHOLD_MS, 6 * HOUR);
});

test("a worker terminal no unfinished run claims is an orphan", () => {
  const root = runsRoot();
  plant(root, "r-live", { status: "watching", session: "team-up-claimed", heartbeatAgeMs: 0 });
  plant(root, "r-done", { status: "done", session: "team-up-finished", heartbeatAgeMs: 0 });
  const orphans = findOrphanSessions({
    root,
    listSessions: () => ["team-up-claimed", "team-up-finished", "team-up-nobody", "my-own-shell"],
  });
  // claimed is in use; finished belongs to a closed run; my-own-shell is not ours.
  assert.deepEqual(orphans, ["team-up-finished", "team-up-nobody"]);
  fs.rmSync(root, { recursive: true, force: true });
});
