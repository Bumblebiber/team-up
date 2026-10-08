import "../helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  evaluateGcAction,
  evaluateIdleSessionAction,
  gcIdleSessions,
  gcRuns,
  claimedWorkerSessions,
  isManagedTeamUpSession,
  sessionClaimsByTmux,
  IDLE_MS,
  GRACE_MS,
} from "../../src/runs/gc.mjs";
import {
  atomicWriteJson,
  atomicWriteText,
  createRun,
  loadState,
  runDir,
  saveState,
  setStatus,
} from "../../src/runs/runs.mjs";

const NOW = Date.parse("2026-07-28T13:00:00.000Z");

function baseState(status = "watching") {
  return { runId: "r1", status, worker: { tmux: "worker-r1" }, cleanup: {} };
}

function withTempRuns(fn) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-gc-"));
    const previous = process.env.TEAM_UP_RUNS;
    process.env.TEAM_UP_RUNS = root;
    try {
      await fn(root);
    } finally {
      if (previous === undefined) delete process.env.TEAM_UP_RUNS;
      else process.env.TEAM_UP_RUNS = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function createGcFixture({ typed = false, status = "watching" } = {}) {
  const state = createRun({
    cwd: "/tmp/project",
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "worker-gc" },
    prompt: "test",
    ...(typed ? { result_protocol: "RESULT.json" } : {}),
    now: new Date("2026-07-28T12:00:00.000Z"),
  });
  setStatus(state.runId, status);
  return loadState(state.runId);
}

test("either fresh signal prevents stale candidacy", () => {
  for (const [heartbeatMs, activityMs] of [
    [NOW - IDLE_MS + 1, NOW - IDLE_MS - 1],
    [NOW - IDLE_MS - 1, NOW - IDLE_MS + 1],
  ]) {
    assert.equal(evaluateGcAction({
      state: baseState(),
      nowMs: NOW,
      heartbeatMs,
      tmux: { exists: true, activityMs },
    }).kind, "noop");
  }
});

test("stale candidates remain report-only after grace", () => {
  const state = baseState();
  const first = evaluateGcAction({
    state,
    nowMs: NOW,
    heartbeatMs: NOW - IDLE_MS - 1,
    tmux: { exists: true, activityMs: NOW - IDLE_MS - 1 },
  });
  assert.equal(first.kind, "mark_stale");

  state.cleanup.stale_detected_at = new Date(NOW - GRACE_MS).toISOString();
  assert.equal(evaluateGcAction({
    state,
    nowMs: NOW,
    heartbeatMs: NOW - IDLE_MS - 1,
    tmux: { exists: true, activityMs: NOW - IDLE_MS - 1 },
  }).kind, "stale");
});

test("protected states are not stale candidates", () => {
  for (const status of [
    "waiting_human",
    "waiting_capacity",
    "waiting_decision",
    "handoff_preparing",
    "handing_off",
  ]) {
    assert.equal(evaluateGcAction({
      state: baseState(status),
      nowMs: NOW,
      heartbeatMs: null,
      tmux: { exists: true, activityMs: null },
    }).kind, "skip");
  }
});

test("gc records stale candidate and fresh activity clears it", withTempRuns(async () => {
  const state = createGcFixture();
  const stopped = [];
  const stale = gcRuns({
    listSessions: () => [],
    now: new Date(NOW),
    heartbeatFor: () => NOW - IDLE_MS - 1,
    inspectTmux: () => ({ exists: true, activityMs: NOW - IDLE_MS - 1 }),
    states: [state],
    stopTmux: (session) => stopped.push(session),
  });
  assert.deepEqual(stale.runs, [{ runId: state.runId, action: "mark_stale" }]);
  assert.equal(loadState(state.runId).status, "watching");
  assert.equal(loadState(state.runId).cleanup.stale_detected_at, new Date(NOW).toISOString());
  assert.deepEqual(stopped, []);

  const fresh = gcRuns({
    listSessions: () => [],
    now: new Date(NOW + 60_000),
    heartbeatFor: () => NOW + 30_000,
    inspectTmux: () => ({ exists: true, activityMs: NOW - IDLE_MS - 1 }),
    states: [loadState(state.runId)],
    stopTmux: (session) => stopped.push(session),
  });
  assert.deepEqual(fresh.runs, [{ runId: state.runId, action: "clear_stale" }]);
  assert.equal(loadState(state.runId).cleanup.stale_detected_at, undefined);
  assert.deepEqual(stopped, []);
}));

test("gc never fails or stops a run that stays stale beyond grace", withTempRuns(async () => {
  const state = createGcFixture({ typed: true });
  const before = loadState(state.runId);
  before.cleanup = {};
  before.cleanup.stale_detected_at = new Date(NOW - IDLE_MS - GRACE_MS - 1).toISOString();
  saveState(before);
  const mailbox = path.join(runDir(state.runId), "mailbox");
  const statusBefore = fs.readFileSync(path.join(mailbox, "STATUS"), "utf8");
  const stopped = [];

  const report = gcRuns({
    listSessions: () => [],
    now: new Date(NOW),
    heartbeatFor: () => NOW - IDLE_MS - 1,
    inspectTmux: () => ({ exists: true, activityMs: NOW - IDLE_MS - 1 }),
    states: [loadState(state.runId)],
    stopTmux: (session) => stopped.push(session),
  });

  assert.deepEqual(report.runs, []);
  assert.equal(loadState(state.runId).status, "watching");
  assert.equal(fs.readFileSync(path.join(mailbox, "STATUS"), "utf8"), statusBefore);
  assert.equal(fs.existsSync(path.join(mailbox, "RESULT.json")), false);
  assert.deepEqual(stopped, []);
}));

test("gc adopts terminal mailbox result and cleans terminal tmux", withTempRuns(async () => {
  const state = createGcFixture({ typed: true });
  const mailbox = path.join(runDir(state.runId), "mailbox");
  const result = {
    schema: "team-up.result/v1",
    status: "success",
    summary: "worker completed",
  };
  atomicWriteJson(path.join(mailbox, "RESULT.json"), result);
  atomicWriteText(path.join(mailbox, "STATUS"), "done\n");
  const stopped = [];

  const report = gcRuns({
    listSessions: () => [],
    states: [loadState(state.runId)],
    heartbeatFor: () => null,
    inspectTmux: () => ({ exists: true, activityMs: null, sessionId: "$gc" }),
    stopTmux: (session) => stopped.push(session),
  });

  assert.deepEqual(report.runs.map((row) => row.action), ["adopt_mailbox", "kill_terminal"]);
  assert.equal(loadState(state.runId).status, "done");
  assert.equal(loadState(state.runId).worker.tmux, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mailbox, "RESULT.json"), "utf8")), result);
  assert.deepEqual(stopped, ["worker-gc"]);
}));

test("gc does not adopt a done while its verifier is running", withTempRuns(async () => {
  const state = createGcFixture({ typed: true });
  const mailbox = path.join(runDir(state.runId), "mailbox");
  const current = loadState(state.runId);
  current.verify = { command: ["true"], runs: 1 };
  saveState(current);
  atomicWriteJson(path.join(mailbox, "RESULT.json"), {
    schema: "team-up.result/v1",
    status: "success",
    summary: "worker completed",
  });
  atomicWriteText(path.join(mailbox, "STATUS"), "done\n");
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    fs.writeFileSync(path.join(mailbox, ".VERIFICATION.lock"), `${holder.pid}\n`);
    const report = gcRuns({
      listSessions: () => [],
      now: new Date(NOW),
      states: [loadState(state.runId)],
      heartbeatFor: () => NOW,
      inspectTmux: () => ({ exists: true, activityMs: NOW }),
      stopTmux: () => assert.fail("must not stop an active run while verifying"),
    });
    assert.deepEqual(report.runs, []);
    assert.equal(loadState(state.runId).status, "watching");
  } finally {
    holder.kill();
  }
}));

test("ordinary terminal kill retries when stopTmux returns false", withTempRuns(async () => {
  const terminal = createGcFixture({ status: "done" });
  const stopped = [];
  let stopCalls = 0;

  const first = gcRuns({
    listSessions: () => [],
    now: new Date(NOW),
    states: [terminal],
    heartbeatFor: () => null,
    inspectTmux: () => ({ exists: true, activityMs: null, sessionId: "$gc" }),
    stopTmux: (session) => {
      stopCalls += 1;
      stopped.push(session);
      return false;
    },
  });

  assert.deepEqual(first.runs, []);
  assert.equal(stopCalls, 1);
  assert.equal(loadState(terminal.runId).worker?.tmux, "worker-gc");
  assert.equal(loadState(terminal.runId).cleanup?.terminal_tmux_stopped_at, undefined);

  const second = gcRuns({
    listSessions: () => [],
    now: new Date(NOW + 60_000),
    states: [loadState(terminal.runId)],
    heartbeatFor: () => null,
    inspectTmux: () => ({ exists: true, activityMs: null, sessionId: "$gc" }),
    stopTmux: (session) => {
      stopCalls += 1;
      stopped.push(session);
      return true;
    },
  });

  assert.deepEqual(second.runs, [{ runId: terminal.runId, action: "kill_terminal" }]);
  assert.equal(stopCalls, 2);
  assert.equal(loadState(terminal.runId).worker?.tmux, undefined);
  assert.ok(loadState(terminal.runId).cleanup?.terminal_tmux_stopped_at);
  assert.deepEqual(stopped, ["worker-gc", "worker-gc"]);

  const third = gcRuns({
    listSessions: () => [],
    now: new Date(NOW + 120_000),
    states: [loadState(terminal.runId)],
    heartbeatFor: () => null,
    inspectTmux: () => ({ exists: true, activityMs: null, sessionId: "$gc" }),
    stopTmux: () => assert.fail("must not stop after cleanup marked"),
  });
  assert.deepEqual(third.runs, []);
  assert.equal(stopCalls, 2);
}));

test("gc terminal cleanup is idempotent and dry-run never mutates", withTempRuns(async () => {
  const terminal = createGcFixture({ status: "done" });
  const stopped = [];
  gcRuns({
    listSessions: () => [],
    now: new Date(NOW),
    states: [terminal],
    heartbeatFor: () => null,
    inspectTmux: () => ({ exists: true, activityMs: null }),
    stopTmux: (session) => stopped.push(session),
  });
  assert.deepEqual(stopped, ["worker-gc"]);

  const active = createGcFixture();
  const before = JSON.stringify(loadState(active.runId));
  const report = gcRuns({
    listSessions: () => [],
    now: new Date(NOW),
    heartbeatFor: () => NOW - IDLE_MS - 1,
    inspectTmux: () => ({ exists: true, activityMs: NOW - IDLE_MS - 1 }),
    states: [active],
    dryRun: true,
    stopTmux: () => assert.fail("dry-run must not stop"),
  });
  assert.deepEqual(report.runs, [{ runId: active.runId, action: "mark_stale" }]);
  assert.equal(JSON.stringify(loadState(active.runId)), before);
}));

test("isManagedTeamUpSession matches generated names only", () => {
  assert.equal(isManagedTeamUpSession("team-up-implementer-m5x2abc"), true);
  assert.equal(isManagedTeamUpSession("team-up-pass-m5x2abc"), true);
  assert.equal(isManagedTeamUpSession("team-up-scratch"), false);
});

test("evaluateIdleSessionAction leaves unclaimed idle sessions alone", () => {
  const idleMs = 2 * 3_600_000;
  const decision = evaluateIdleSessionAction({
    sessionName: "team-up-implementer-m5x2abc",
    attached: false,
    activityMs: NOW - idleMs - 1,
    nowMs: NOW,
    idleSessionMs: idleMs,
    sessionClaims: new Map(),
  });
  assert.equal(decision.kind, "skip");
});

test("evaluateIdleSessionAction kills idle terminal-run session", () => {
  const idleMs = 2 * 3_600_000;
  const claims = sessionClaimsByTmux([
    { status: "done", worker: { tmux: "team-up-implementer-m5x2abc" } },
  ]);
  const decision = evaluateIdleSessionAction({
    sessionName: "team-up-implementer-m5x2abc",
    attached: false,
    activityMs: NOW - idleMs - 1,
    nowMs: NOW,
    idleSessionMs: idleMs,
    sessionClaims: claims,
  });
  assert.equal(decision.kind, "kill_idle");
});

test("evaluateIdleSessionAction skips attached or live-run sessions", () => {
  const idleMs = 2 * 3_600_000;
  const claims = sessionClaimsByTmux([
    { status: "watching", worker: { tmux: "team-up-implementer-m5x2abc" } },
  ]);
  for (const attached of [true, false]) {
    assert.equal(evaluateIdleSessionAction({
      sessionName: "team-up-implementer-m5x2abc",
      attached,
      activityMs: NOW - idleMs - 1,
      nowMs: NOW,
      idleSessionMs: idleMs,
      sessionClaims: claims,
    }).kind, "skip");
  }
});

test("claimedWorkerSessions ignores terminal runs and includes parent tmux", () => {
  const claimed = claimedWorkerSessions([
    { status: "done", worker: { tmux: "team-up-old" } },
    { status: "watching", worker: { tmux: "team-up-live" }, parent: { tmux: "team-up-parent" } },
  ]);
  assert.deepEqual([...claimed].sort(), ["team-up-live", "team-up-parent"]);
});

test("gcIdleSessions honours dry-run and kills only idle terminal sessions", () => {
  const idleMs = 2 * 3_600_000;
  const stopped = [];
  const report = gcIdleSessions({
    now: new Date(NOW),
    states: [
      { status: "watching", worker: { tmux: "team-up-live-m5x2" } },
      { status: "done", worker: { tmux: "team-up-done-m5x2" } },
    ],
    listSessions: () => ["team-up-live-m5x2", "team-up-done-m5x2", "team-up-pass-m5x2", "team-up-scratch", "other"],
    inspectTmux: (name) => ({
      exists: true,
      attached: name === "team-up-live-m5x2",
      activityMs: NOW - idleMs - 1,
      sessionId: `$${name}`,
    }),
    stopTmux: (name) => {
      stopped.push(name);
      return true;
    },
    dryRun: true,
  });
  assert.deepEqual(report.killed, ["team-up-done-m5x2"]);
  assert.deepEqual(stopped, []);
});

test("gcIdleSessions continues after stopTmux throw", () => {
  const idleMs = 2 * 3_600_000;
  const stopped = [];
  const report = gcIdleSessions({
    now: new Date(NOW),
    states: [
      { status: "done", worker: { tmux: "team-up-fail-m5x2" } },
      { status: "done", worker: { tmux: "team-up-ok-m5x2" } },
    ],
    listSessions: () => ["team-up-fail-m5x2", "team-up-ok-m5x2"],
    inspectTmux: () => ({
      exists: true,
      attached: false,
      activityMs: NOW - idleMs - 1,
      sessionId: "$id",
    }),
    stopTmux: (name) => {
      if (name === "team-up-fail-m5x2") throw new Error("tmux busy");
      stopped.push(name);
    },
  });
  assert.deepEqual(report.killed, ["team-up-ok-m5x2"]);
  assert.equal(report.errors.length, 1);
  assert.deepEqual(stopped, ["team-up-ok-m5x2"]);
});
