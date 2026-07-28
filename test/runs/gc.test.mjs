import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateGcAction,
  gcRuns,
  IDLE_MS,
  GRACE_MS,
} from "../../src/runs/gc.mjs";
import {
  createRun,
  loadState,
  runDir,
  saveState,
  setStatus,
} from "../../src/runs/runs.mjs";
import {
  acquireAttemptLease,
  createAttempt,
} from "../../src/supervisor/attempts.mjs";

const NOW = Date.parse("2026-07-28T13:00:00.000Z");

function baseState(status = "watching") {
  return {
    runId: "r1",
    status,
    worker: { tmux: "worker-r1" },
    cleanup: {},
  };
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

test("dual 30 minute staleness starts grace before kill", () => {
  const first = evaluateGcAction({
    state: baseState(),
    nowMs: NOW,
    heartbeatMs: NOW - IDLE_MS - 1,
    tmux: { exists: true, activityMs: NOW - IDLE_MS - 1 },
  });
  assert.equal(first.kind, "mark_stale");

  const candidate = baseState();
  candidate.cleanup.stale_detected_at = new Date(NOW - GRACE_MS + 1).toISOString();
  assert.equal(evaluateGcAction({
    state: candidate,
    nowMs: NOW,
    heartbeatMs: NOW - IDLE_MS - 1,
    tmux: { exists: true, activityMs: NOW - IDLE_MS - 1 },
  }).kind, "grace");
});

test("continued dual staleness through grace fails worker", () => {
  const state = baseState();
  state.cleanup.stale_detected_at = new Date(NOW - GRACE_MS).toISOString();
  assert.equal(evaluateGcAction({
    state,
    nowMs: NOW,
    heartbeatMs: NOW - IDLE_MS - 1,
    tmux: { exists: true, activityMs: NOW - IDLE_MS - 1 },
  }).kind, "fail_stale");
});

test("protected states never stale-kill", () => {
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

const staleDeps = {
  now: new Date(NOW),
  heartbeatFor: () => NOW - IDLE_MS - 1,
  inspectTmux: () => ({ exists: true, activityMs: NOW - IDLE_MS - 1 }),
};

test("gc records stale candidate and fresh activity clears it", withTempRuns(async () => {
  const state = createGcFixture();
  const stopped = [];
  gcRuns({
    ...staleDeps,
    states: [state],
    stopTmux: session => stopped.push(session),
    releaseLease: () => assert.fail("must not release during grace"),
  });
  assert.equal(
    loadState(state.runId).cleanup.stale_detected_at,
    new Date(NOW).toISOString(),
  );
  assert.deepEqual(stopped, []);

  gcRuns({
    now: new Date(NOW + 60_000),
    states: [loadState(state.runId)],
    heartbeatFor: () => NOW + 30_000,
    inspectTmux: () => ({ exists: true, activityMs: NOW - IDLE_MS - 1 }),
    stopTmux: session => stopped.push(session),
    releaseLease: () => assert.fail("must not release after fresh activity"),
  });
  assert.equal(loadState(state.runId).cleanup.stale_detected_at, undefined);
}));

test("gc fails typed worker after 30+10 and cleans lease before tmux", withTempRuns(async () => {
  const state = createGcFixture({ typed: true });
  const candidate = loadState(state.runId);
  candidate.cleanup = {
    stale_detected_at: new Date(NOW - GRACE_MS).toISOString(),
  };
  candidate.current_attempt_id = "attempt-1";
  saveState(candidate);
  const effects = [];

  const report = gcRuns({
    ...staleDeps,
    states: [loadState(state.runId)],
    releaseLease: input => effects.push(["release", input]),
    stopTmux: session => effects.push(["stop", session]),
  });

  assert.equal(report.runs[0].action, "fail_stale");
  assert.equal(loadState(state.runId).status, "failed");
  assert.equal(
    fs.readFileSync(path.join(runDir(state.runId), "mailbox", "STATUS"), "utf8").trim(),
    "failed",
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(runDir(state.runId), "mailbox", "RESULT.json"), "utf8")),
    {
      schema: "team-up.result/v1",
      status: "failed",
      summary: "worker_stale_timeout",
    },
  );
  assert.deepEqual(effects, [
    ["release", {
      runId: state.runId,
      attemptId: "attempt-1",
      reason: "worker_stale_timeout",
      now: new Date(NOW).toISOString(),
    }],
    ["stop", "worker-gc"],
  ]);
}));

function staleCandidateFixture({ typed = false } = {}) {
  const state = createGcFixture({ typed });
  const candidate = loadState(state.runId);
  candidate.cleanup = {
    stale_detected_at: new Date(NOW - GRACE_MS).toISOString(),
  };
  saveState(candidate);
  return loadState(state.runId);
}

test("gc aborts stale failure when state becomes protected during confirmation", withTempRuns(async () => {
  const state = staleCandidateFixture();
  const stopped = [];

  gcRuns({
    ...staleDeps,
    states: [state],
    onBeforeStaleConfirmation: ({ runId }) => {
      const latest = loadState(runId);
      latest.status = "waiting_human";
      latest.worker = { ...latest.worker, tmux: "worker-replacement" };
      saveState(latest);
    },
    stopTmux: session => stopped.push(session),
    releaseLease: () => assert.fail("must not release when stale failure aborts"),
  });

  assert.equal(loadState(state.runId).status, "waiting_human");
  assert.equal(loadState(state.runId).worker.tmux, "worker-replacement");
  assert.deepEqual(stopped, []);
}));

test("gc clears stale candidacy when activity becomes fresh during confirmation", withTempRuns(async () => {
  const state = staleCandidateFixture();
  const stopped = [];
  let heartbeatReads = 0;

  gcRuns({
    ...staleDeps,
    states: [state],
    heartbeatFor: () => {
      heartbeatReads += 1;
      return heartbeatReads === 1 ? NOW - IDLE_MS - 1 : NOW;
    },
    stopTmux: session => stopped.push(session),
    releaseLease: () => assert.fail("must not release when activity is fresh"),
  });

  assert.equal(loadState(state.runId).status, "watching");
  assert.equal(loadState(state.runId).cleanup.stale_detected_at, undefined);
  assert.deepEqual(stopped, []);
}));

test("gc defers tmux stop when lease release is busy and retries next sweep", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const candidate = loadState(state.runId);
  candidate.current_attempt_id = "attempt-1";
  saveState(candidate);
  const stopped = [];
  let releaseCalls = 0;

  const first = gcRuns({
    ...staleDeps,
    states: [loadState(state.runId)],
    releaseLease: input => {
      releaseCalls += 1;
      return { ok: false, reason: "lock_busy" };
    },
    stopTmux: session => stopped.push(session),
  });

  assert.equal(first.runs[0].action, "pending_lease");
  assert.equal(first.runs[0].leaseError, "lock_busy");
  assert.equal(loadState(state.runId).status, "failed");
  assert.equal(loadState(state.runId).cleanup.pending_lease_release?.worker_tmux, "worker-gc");
  assert.equal(loadState(state.runId).cleanup.pending_lease_release?.attempt_id, "attempt-1");
  assert.deepEqual(stopped, []);

  const second = gcRuns({
    ...staleDeps,
    states: [loadState(state.runId)],
    releaseLease: input => {
      releaseCalls += 1;
      assert.deepEqual(input, {
        runId: state.runId,
        attemptId: "attempt-1",
        reason: "worker_stale_timeout",
        now: new Date(NOW).toISOString(),
      });
      return { ok: true };
    },
    stopTmux: session => stopped.push(session),
  });

  assert.equal(second.runs[0].action, "completed_pending_lease");
  assert.equal(loadState(state.runId).cleanup.pending_lease_release, undefined);
  assert.deepEqual(stopped, ["worker-gc"]);
  assert.equal(releaseCalls, 2);
}));

test("gc releases active lease from lease reader when state omits current_attempt_id", withTempRuns(async () => {
  const state = staleCandidateFixture();
  const attempt = createAttempt({ runId: state.runId, runtime: { cli: "codex" } });
  assert.equal(
    acquireAttemptLease({
      runId: state.runId,
      attemptId: attempt.id,
      expectedPrevious: null,
      now: new Date(NOW).toISOString(),
    }).ok,
    true,
  );
  const candidate = loadState(state.runId);
  delete candidate.current_attempt_id;
  saveState(candidate);
  const effects = [];

  gcRuns({
    ...staleDeps,
    states: [loadState(state.runId)],
    releaseLease: input => effects.push(["release", input]),
    stopTmux: session => effects.push(["stop", session]),
  });

  assert.deepEqual(effects, [
    ["release", {
      runId: state.runId,
      attemptId: attempt.id,
      reason: "worker_stale_timeout",
      now: new Date(NOW).toISOString(),
    }],
    ["stop", "worker-gc"],
  ]);
}));

test("gc terminal cleanup is idempotent and dry-run never mutates", withTempRuns(async () => {
  const terminal = createGcFixture({ status: "done" });
  const stopped = [];
  gcRuns({
    now: new Date(NOW),
    states: [terminal],
    heartbeatFor: () => null,
    inspectTmux: () => ({ exists: true, activityMs: null }),
    stopTmux: session => stopped.push(session),
  });
  assert.deepEqual(stopped, ["worker-gc"]);

  const active = createGcFixture();
  const before = JSON.stringify(loadState(active.runId));
  const report = gcRuns({
    ...staleDeps,
    states: [active],
    dryRun: true,
    stopTmux: () => assert.fail("dry-run must not stop"),
    releaseLease: () => assert.fail("dry-run must not release"),
  });
  assert.equal(report.runs[0].action, "mark_stale");
  assert.equal(JSON.stringify(loadState(active.runId)), before);
}));
