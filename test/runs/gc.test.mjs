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
  atomicWriteJson,
  atomicWriteText,
  createRun,
  loadState,
  runDir,
  saveState,
  setStatus,
  waitMailbox,
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
      aliveTmuxSessions.clear();
      aliveTmuxSessions.add("$gc");
      aliveTmuxSessions.add("$old");
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

const aliveTmuxSessions = new Set(["$gc", "$old"]);

function makeStaleDeps(overrides = {}) {
  const { stopTmux: stopTmuxOverride, ...rest } = overrides;
  return {
    now: new Date(NOW),
    heartbeatFor: () => NOW - IDLE_MS - 1,
    inspectTmux: () => ({ exists: true, activityMs: NOW - IDLE_MS - 1, sessionId: "$gc" }),
    tmuxExists: sessionId => aliveTmuxSessions.has(sessionId),
    stopTmux: session => {
      aliveTmuxSessions.delete(session);
      if (typeof stopTmuxOverride === "function") {
        return stopTmuxOverride(session);
      }
    },
    ...rest,
  };
}

const staleDeps = makeStaleDeps();

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
    ...makeStaleDeps({
      stopTmux: session => effects.push(["stop", session]),
    }),
    states: [loadState(state.runId)],
    releaseLease: input => effects.push(["release", input]),
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
    ["stop", "$gc"],
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
    ...makeStaleDeps({
      stopTmux: session => stopped.push(session),
    }),
    states: [loadState(state.runId)],
    releaseLease: input => {
      releaseCalls += 1;
      return { ok: false, reason: "lock_busy" };
    },
  });

  assert.equal(first.runs[0].action, "pending_lease");
  assert.equal(first.runs[0].leaseError, "lock_busy");
  assert.equal(loadState(state.runId).status, "watching");
  assert.equal(loadState(state.runId).cleanup.stale_publication_claim?.phase, "claimed");
  assert.equal(loadState(state.runId).cleanup.stale_publication_claim?.attempt_id, "attempt-1");
  assert.deepEqual(stopped, []);

  const second = gcRuns({
    ...makeStaleDeps({
      stopTmux: session => stopped.push(session),
    }),
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
  });

  assert.equal(second.runs[0].action, "fail_stale");
  assert.equal(loadState(state.runId).cleanup.stale_publication_claim, undefined);
  assert.deepEqual(stopped, ["$gc"]);
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
    ["stop", "$gc"],
  ]);
}));

test("gc reconciles legitimate mailbox closeout during stale confirmation", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const mb = path.join(runDir(state.runId), "mailbox");
  const legitimate = {
    schema: "team-up.result/v1",
    status: "success",
    summary: "completed normally",
  };

  gcRuns({
    ...staleDeps,
    states: [state],
    onBeforeStaleConfirmation: ({ runId }) => {
      atomicWriteJson(path.join(runDir(runId), "mailbox", "RESULT.json"), legitimate);
      atomicWriteText(path.join(runDir(runId), "mailbox", "STATUS"), "done\n");
    },
    releaseLease: () => assert.fail("must not release on legitimate completion"),
    stopTmux: () => assert.fail("must not stop on legitimate completion"),
  });

  const latest = loadState(state.runId);
  assert.equal(latest.status, "done");
  assert.equal(latest.cleanup?.stale_detected_at, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mb, "RESULT.json"), "utf8")), legitimate);
  assert.equal(fs.readFileSync(path.join(mb, "STATUS"), "utf8").trim(), "done");
}));

test("gc stale failure persists claim before release attempt", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const candidate = loadState(state.runId);
  candidate.current_attempt_id = "attempt-1";
  saveState(candidate);
  const observed = [];
  let releaseStarted = false;

  gcRuns({
    ...makeStaleDeps(),
    states: [loadState(state.runId)],
    releaseLease: input => {
      releaseStarted = true;
      const claim = loadState(state.runId).cleanup?.stale_publication_claim;
      observed.push(["release", claim?.token, claim?.worker_tmux_id]);
      return { ok: false, reason: "lock_busy" };
    },
    stopTmux: session => observed.push(["stop", session]),
  });

  assert.equal(releaseStarted, true);
  assert.equal(observed[0][0], "release");
  assert.match(observed[0][1], new RegExp(`^${state.runId}\\.`));
  assert.equal(observed[0][2], "$gc");
  assert.equal(observed.some(entry => entry[0] === "stop"), false);
  assert.equal(
    fs.readFileSync(path.join(runDir(state.runId), "mailbox", "STATUS"), "utf8").trim(),
    "watching",
  );
}));

test("stale cleanup aborts when worker recovers after lease release", withTempRuns(async () => {
  const state = staleCandidateFixture();
  const candidate = loadState(state.runId);
  const detectedAt = candidate.cleanup.stale_detected_at;
  candidate.cleanup = {
    stale_publication_claim: {
      token: `${state.runId}.pending-token`,
      worker_tmux: "worker-gc",
      worker_tmux_id: "$gc",
      attempt_id: "attempt-1",
      stale_detected_at: detectedAt,
      phase: "lease_released",
      claimed_at: new Date(NOW).toISOString(),
      lease_released_at: new Date(NOW).toISOString(),
    },
  };
  delete candidate.cleanup.stale_detected_at;
  saveState(candidate);
  const stopped = [];
  const latest = loadState(state.runId);
  latest.worker = { ...latest.worker, tmux: "replacement-worker" };
  latest.supervision = { generation: 2 };
  saveState(latest);

  gcRuns({
    ...makeStaleDeps(),
    states: [loadState(state.runId)],
    releaseLease: () => assert.fail("must not release after lease_released"),
    stopTmux: session => stopped.push(session),
  });

  assert.deepEqual(stopped, []);
  assert.equal(loadState(state.runId).cleanup?.stale_publication_claim, undefined);
  assert.equal(loadState(state.runId).worker.tmux, "replacement-worker");
}));

test("stale cleanup clears claim when lease was replaced", withTempRuns(async () => {
  const state = staleCandidateFixture();
  const candidate = loadState(state.runId);
  const detectedAt = candidate.cleanup.stale_detected_at;
  candidate.cleanup = {
    stale_publication_claim: {
      token: `${state.runId}.old`,
      worker_tmux: "worker-gc",
      worker_tmux_id: "$gc",
      attempt_id: "attempt-old",
      stale_detected_at: detectedAt,
      phase: "claimed",
      claimed_at: new Date(NOW).toISOString(),
    },
  };
  delete candidate.cleanup.stale_detected_at;
  saveState(candidate);
  const stopped = [];

  gcRuns({
    ...makeStaleDeps(),
    states: [loadState(state.runId)],
    releaseLease: () => ({ ok: false, reason: "not_holder", current: "attempt-new" }),
    stopTmux: session => stopped.push(session),
  });

  assert.deepEqual(stopped, []);
  assert.equal(loadState(state.runId).cleanup?.stale_publication_claim, undefined);
}));

test("gc continues other runs when stale claim lease release throws", withTempRuns(async () => {
  const stale = staleCandidateFixture();
  const terminal = createGcFixture({ status: "done" });
  const staleCandidate = loadState(stale.runId);
  const detectedAt = staleCandidate.cleanup.stale_detected_at;
  staleCandidate.cleanup = {
    stale_publication_claim: {
      token: `${stale.runId}.throw`,
      worker_tmux: "worker-gc",
      worker_tmux_id: "$gc",
      attempt_id: "attempt-1",
      stale_detected_at: detectedAt,
      phase: "claimed",
      claimed_at: new Date(NOW).toISOString(),
    },
  };
  delete staleCandidate.cleanup.stale_detected_at;
  saveState(staleCandidate);
  const stopped = [];
  let releaseCalls = 0;

  const report = gcRuns({
    ...makeStaleDeps(),
    states: [loadState(stale.runId), terminal],
    releaseLease: input => {
      releaseCalls += 1;
      if (input.runId === stale.runId) throw new Error("lease store unavailable");
      return { ok: true };
    },
    stopTmux: session => stopped.push(session),
  });

  assert.equal(releaseCalls, 1);
  assert.equal(report.runs[0].action, "pending_lease");
  assert.match(report.runs[0].leaseError, /lease store unavailable/);
  assert.equal(report.runs[1].action, "kill_terminal");
  assert.deepEqual(stopped, ["worker-gc"]);
}));

test("gc preserves legitimate result at finalize boundary", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const mb = path.join(runDir(state.runId), "mailbox");
  const legitimate = {
    schema: "team-up.result/v1",
    status: "success",
    summary: "worker won the race",
  };

  gcRuns({
    ...makeStaleDeps(),
    states: [state],
    onBeforeStaleArtifactPublish: ({ runId }) => {
      atomicWriteJson(path.join(runDir(runId), "mailbox", "RESULT.json"), legitimate);
      atomicWriteText(path.join(runDir(runId), "mailbox", "STATUS"), "done\n");
    },
    releaseLease: () => ({ ok: true }),
  });

  const latest = loadState(state.runId);
  assert.equal(latest.status, "done");
  assert.equal(latest.cleanup?.stale_reason, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mb, "RESULT.json"), "utf8")), legitimate);
  assert.equal(fs.readFileSync(path.join(mb, "STATUS"), "utf8").trim(), "done");
}));

test("gc reconciles legitimate result written after stale claim", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const mb = path.join(runDir(state.runId), "mailbox");
  const legitimate = {
    schema: "team-up.result/v1",
    status: "success",
    summary: "worker won after claim",
  };

  gcRuns({
    ...makeStaleDeps(),
    states: [state],
    onAfterClaim: ({ runId }) => {
      atomicWriteJson(path.join(runDir(runId), "mailbox", "RESULT.json"), legitimate);
      atomicWriteText(path.join(runDir(runId), "mailbox", "STATUS"), "done\n");
    },
    releaseLease: () => ({ ok: true }),
  });

  const latest = loadState(state.runId);
  assert.equal(latest.status, "done");
  assert.equal(latest.cleanup?.stale_reason, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mb, "RESULT.json"), "utf8")), legitimate);
}));

test("gc later sweep reconciles legitimate result over synthetic stale failure", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const mb = path.join(runDir(state.runId), "mailbox");
  const legitimate = {
    schema: "team-up.result/v1",
    status: "success",
    summary: "late legitimate completion",
  };
  const stopped = [];

  gcRuns({
    ...makeStaleDeps({
      inspectTmux: () => ({
        exists: true,
        activityMs: NOW - IDLE_MS - 1,
        sessionId: "$111",
      }),
      stopTmux: session => stopped.push(session),
    }),
    states: [state],
    releaseLease: () => ({ ok: true }),
  });

  assert.equal(loadState(state.runId).status, "failed");
  assert.equal(loadState(state.runId).cleanup?.stale_reason, "worker_stale_timeout");

  atomicWriteJson(path.join(mb, "RESULT.json"), legitimate);
  atomicWriteText(path.join(mb, "STATUS"), "done\n");

  const second = gcRuns({
    ...staleDeps,
    states: [loadState(state.runId)],
    releaseLease: () => assert.fail("must not release on reconciliation sweep"),
    stopTmux: session => stopped.push(session),
    inspectTmux: () => ({ exists: false, activityMs: null, sessionId: null }),
  });

  const latest = loadState(state.runId);
  assert.equal(latest.status, "done");
  assert.equal(latest.cleanup?.stale_reason, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mb, "RESULT.json"), "utf8")), legitimate);
  assert.equal(second.runs[0].action, "reconcile_stale_failure");
}));

test("stale tmux stop targets immutable session id when name is reused", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const candidate = loadState(state.runId);
  candidate.current_attempt_id = "attempt-1";
  candidate.cleanup.worker_tmux_id = "$old";
  saveState(candidate);
  const stopped = [];
  let inspectCalls = 0;

  gcRuns({
    ...makeStaleDeps({
      inspectTmux: session => {
        inspectCalls += 1;
        const staleActivity = NOW - IDLE_MS - 1;
        if (inspectCalls <= 2) {
          return { exists: true, activityMs: staleActivity, sessionId: "$old" };
        }
        return { exists: true, activityMs: staleActivity, sessionId: "$new" };
      },
      tmuxExists: sessionId => aliveTmuxSessions.has(sessionId),
      stopTmux: session => {
        aliveTmuxSessions.delete(session);
        stopped.push(session);
      },
    }),
    states: [loadState(state.runId)],
    releaseLease: () => ({ ok: true }),
  });

  assert.deepEqual(stopped, ["$old"]);
  assert.equal(stopped.includes("worker-gc"), false);
}));

test("stale tmux stop is no-op when immutable session id is gone", withTempRuns(async () => {
  const state = staleCandidateFixture();
  const candidate = loadState(state.runId);
  const detectedAt = candidate.cleanup.stale_detected_at;
  candidate.cleanup = {
    stale_publication_claim: {
      token: `${state.runId}.pending`,
      worker_tmux: "worker-gc",
      worker_tmux_id: "$gone",
      attempt_id: "attempt-1",
      stale_detected_at: detectedAt,
      phase: "lease_released",
      claimed_at: new Date(NOW).toISOString(),
      lease_released_at: new Date(NOW).toISOString(),
    },
  };
  delete candidate.cleanup.stale_detected_at;
  saveState(candidate);
  const stopped = [];

  gcRuns({
    ...makeStaleDeps({
      tmuxExists: sessionId => sessionId !== "$gone",
    }),
    states: [loadState(state.runId)],
    releaseLease: () => ({ ok: true }),
    stopTmux: session => stopped.push(session),
  });

  assert.deepEqual(stopped, []);
  assert.equal(loadState(state.runId).status, "failed");
}));

test("terminal sweep after immutable stale stop never targets reused tmux name", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const candidate = loadState(state.runId);
  candidate.current_attempt_id = "attempt-1";
  candidate.cleanup.worker_tmux_id = "$old";
  saveState(candidate);
  const stopped = [];
  let inspectCalls = 0;

  gcRuns({
    ...makeStaleDeps({
      inspectTmux: session => {
        inspectCalls += 1;
        const staleActivity = NOW - IDLE_MS - 1;
        if (inspectCalls <= 2) {
          return { exists: true, activityMs: staleActivity, sessionId: "$old" };
        }
        return { exists: true, activityMs: staleActivity, sessionId: "$new" };
      },
      tmuxExists: sessionId => aliveTmuxSessions.has(sessionId),
      stopTmux: session => {
        aliveTmuxSessions.delete(session);
        stopped.push(session);
      },
    }),
    states: [loadState(state.runId)],
    releaseLease: () => ({ ok: true }),
  });

  assert.deepEqual(stopped, ["$old"]);
  assert.equal(loadState(state.runId).status, "failed");

  const terminal = loadState(state.runId);
  terminal.status = "done";
  saveState(terminal);
  aliveTmuxSessions.add("$new");

  gcRuns({
    now: new Date(NOW + 60_000),
    states: [loadState(state.runId)],
    heartbeatFor: () => null,
    inspectTmux: () => ({ exists: true, activityMs: null, sessionId: "$new" }),
    tmuxExists: sessionId => aliveTmuxSessions.has(sessionId),
    stopTmux: session => stopped.push(session),
    releaseLease: () => assert.fail("terminal sweep must not release lease"),
  });

  assert.deepEqual(stopped, ["$old"]);
}));

test("typed blocked result without STATUS finalizes as waiting_human not synthetic failed", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const mb = path.join(runDir(state.runId), "mailbox");
  const blocked = {
    schema: "team-up.result/v1",
    status: "blocked",
    summary: "need input",
    questions: ["Approve network access?"],
  };
  atomicWriteJson(path.join(mb, "RESULT.json"), blocked);
  try {
    fs.unlinkSync(path.join(mb, "STATUS"));
  } catch {
    /* already absent */
  }
  const candidate = loadState(state.runId);
  const detectedAt = candidate.cleanup.stale_detected_at;
  candidate.cleanup = {
    stale_publication_claim: {
      token: `${state.runId}.blocked`,
      worker_tmux: "worker-gc",
      worker_tmux_id: "$gc",
      stale_detected_at: detectedAt,
      phase: "tmux_stopped",
      claimed_at: new Date(NOW).toISOString(),
      lease_released_at: new Date(NOW).toISOString(),
      tmux_stopped_at: new Date(NOW).toISOString(),
    },
  };
  delete candidate.cleanup.stale_detected_at;
  saveState(candidate);
  const stopped = [];

  gcRuns({
    ...makeStaleDeps({
      stopTmux: session => stopped.push(session),
    }),
    states: [loadState(state.runId)],
    releaseLease: () => ({ ok: true }),
  });

  const latest = loadState(state.runId);
  assert.equal(latest.status, "waiting_human");
  assert.equal(latest.cleanup?.stale_reason, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mb, "RESULT.json"), "utf8")), blocked);
  assert.equal(fs.existsSync(path.join(mb, "STATUS")), false);
  assert.deepEqual(stopped, []);
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

test("typed result without STATUS finalizes after stop without overwrite", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const mb = path.join(runDir(state.runId), "mailbox");
  const legitimate = {
    schema: "team-up.result/v1",
    status: "success",
    summary: "worker completed without final status",
  };
  const stopped = [];

  gcRuns({
    ...makeStaleDeps({
      stopTmux: session => stopped.push(session),
    }),
    states: [loadState(state.runId)],
    onAfterClaim: ({ runId }) => {
      atomicWriteJson(path.join(runDir(runId), "mailbox", "RESULT.json"), legitimate);
    },
    releaseLease: () => ({ ok: true }),
  });

  const latest = loadState(state.runId);
  assert.equal(latest.status, "done");
  assert.equal(latest.cleanup?.stale_publication_claim, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mb, "RESULT.json"), "utf8")), legitimate);
  assert.equal(fs.readFileSync(path.join(mb, "STATUS"), "utf8").trim(), "done");
  assert.deepEqual(stopped, ["$gc"]);
}));

test("legacy result without STATUS finalizes after stop without overwrite", withTempRuns(async () => {
  const state = staleCandidateFixture();
  const mb = path.join(runDir(state.runId), "mailbox");
  const stopped = [];

  gcRuns({
    ...makeStaleDeps({
      stopTmux: session => stopped.push(session),
    }),
    states: [loadState(state.runId)],
    onAfterClaim: ({ runId }) => {
      atomicWriteText(path.join(runDir(runId), "mailbox", "RESULT.md"), "worker completed without final status\n");
    },
    releaseLease: () => ({ ok: true }),
  });

  const latest = loadState(state.runId);
  assert.equal(latest.status, "done");
  assert.equal(latest.cleanup?.stale_publication_claim, undefined);
  assert.equal(fs.readFileSync(path.join(mb, "RESULT.md"), "utf8").trim(), "worker completed without final status");
  assert.equal(fs.readFileSync(path.join(mb, "STATUS"), "utf8").trim(), "done");
  assert.deepEqual(stopped, ["$gc"]);
}));

test("crash after tmux stop resumes and finalizes stale failure", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const candidate = loadState(state.runId);
  const detectedAt = candidate.cleanup.stale_detected_at;
  candidate.cleanup = {
    stale_publication_claim: {
      token: `${state.runId}.crash-result`,
      worker_tmux: "worker-gc",
      worker_tmux_id: "$old",
      stale_detected_at: detectedAt,
      phase: "tmux_stopped",
      claimed_at: new Date(NOW).toISOString(),
      lease_released_at: new Date(NOW).toISOString(),
      tmux_stopped_at: new Date(NOW).toISOString(),
    },
  };
  delete candidate.cleanup.stale_detected_at;
  saveState(candidate);

  const stopped = [];
  gcRuns({
    ...makeStaleDeps({
      tmuxExists: () => false,
    }),
    states: [loadState(state.runId)],
    releaseLease: () => assert.fail("must not release after stop"),
  });

  const latest = loadState(state.runId);
  assert.equal(latest.status, "failed");
  assert.equal(latest.cleanup?.stale_publication_claim, undefined);
  assert.equal(fs.readFileSync(path.join(runDir(state.runId), "mailbox", "STATUS"), "utf8").trim(), "failed");
  assert.deepEqual(stopped, []);
}));

test("crash during lease release resumes claim on next sweep", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const candidate = loadState(state.runId);
  const detectedAt = candidate.cleanup.stale_detected_at;
  candidate.current_attempt_id = "attempt-1";
  candidate.cleanup = {
    stale_publication_claim: {
      token: `${state.runId}.crash-lease`,
      worker_tmux: "worker-gc",
      worker_tmux_id: "$gc",
      attempt_id: "attempt-1",
      stale_detected_at: detectedAt,
      phase: "claimed",
      claimed_at: new Date(NOW).toISOString(),
    },
  };
  delete candidate.cleanup.stale_detected_at;
  saveState(candidate);
  let releaseCalls = 0;

  const first = gcRuns({
    ...makeStaleDeps(),
    states: [loadState(state.runId)],
    releaseLease: () => {
      releaseCalls += 1;
      throw new Error("lease store unavailable");
    },
    stopTmux: () => assert.fail("must not stop before lease release"),
  });

  assert.equal(releaseCalls, 1);
  assert.equal(first.runs[0].action, "pending_lease");
  assert.equal(loadState(state.runId).cleanup?.stale_publication_claim?.phase, "claimed");

  const second = gcRuns({
    ...makeStaleDeps(),
    states: [loadState(state.runId)],
    releaseLease: () => ({ ok: true }),
  });

  assert.equal(second.runs[0].action, "fail_stale");
  assert.equal(loadState(state.runId).status, "failed");
  assert.equal(loadState(state.runId).cleanup?.stale_publication_claim, undefined);
}));

test("crash during tmux stop retries same immutable session id", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const candidate = loadState(state.runId);
  const detectedAt = candidate.cleanup.stale_detected_at;
  candidate.cleanup = {
    stale_publication_claim: {
      token: `${state.runId}.crash-stop`,
      worker_tmux: "worker-gc",
      worker_tmux_id: "$old",
      stale_detected_at: detectedAt,
      phase: "lease_released",
      claimed_at: new Date(NOW).toISOString(),
      lease_released_at: new Date(NOW).toISOString(),
    },
  };
  delete candidate.cleanup.stale_detected_at;
  saveState(candidate);
  const stopped = [];
  let stopCalls = 0;

  const first = gcRuns({
    ...makeStaleDeps({
      stopTmux: session => {
        aliveTmuxSessions.delete(session);
        stopCalls += 1;
        stopped.push(session);
        throw new Error("tmux kill failed");
      },
    }),
    states: [loadState(state.runId)],
    releaseLease: () => assert.fail("must not release after lease_released"),
  });

  assert.equal(stopCalls, 1);
  assert.deepEqual(stopped, ["$old"]);
  assert.equal(first.runs[0].action, "pending_claim");
  assert.equal(loadState(state.runId).cleanup?.stale_publication_claim?.phase, "lease_released");

  const second = gcRuns({
    ...makeStaleDeps({
      stopTmux: session => stopped.push(session),
    }),
    states: [loadState(state.runId)],
    releaseLease: () => assert.fail("must not release on stop retry"),
  });

  assert.equal(second.runs[0].action, "fail_stale");
  assert.deepEqual(stopped, ["$old"]);
}));

test("claim is durable before release with no mailbox mutation", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const candidate = loadState(state.runId);
  candidate.current_attempt_id = "attempt-1";
  saveState(candidate);
  let observedClaim = false;

  gcRuns({
    ...makeStaleDeps(),
    states: [loadState(state.runId)],
    releaseLease: () => {
      const latest = loadState(state.runId);
      observedClaim = Boolean(latest.cleanup?.stale_publication_claim);
      assert.equal(latest.cleanup?.stale_publication_claim?.phase, "claimed");
      assert.equal(
        fs.existsSync(path.join(runDir(state.runId), "mailbox", "STATUS")),
        false,
      );
      return { ok: false, reason: "lock_busy" };
    },
    stopTmux: () => assert.fail("must not stop before lease release"),
  });

  assert.equal(observedClaim, true);
}));

test("watcher defers failed reconciliation and tmux stop during unresolved claim", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const mb = path.join(runDir(state.runId), "mailbox");
  const legitimate = {
    schema: "team-up.result/v1",
    status: "success",
    summary: "worker still closing out",
  };
  atomicWriteJson(path.join(mb, "RESULT.json"), legitimate);
  const candidate = loadState(state.runId);
  candidate.cleanup = {
    stale_publication_claim: {
      token: `${state.runId}.watcher`,
      worker_tmux: "worker-gc",
      worker_tmux_id: "$old",
      stale_detected_at: candidate.cleanup.stale_detected_at,
      phase: "lease_released",
      claimed_at: new Date(NOW).toISOString(),
      lease_released_at: new Date(NOW).toISOString(),
    },
  };
  delete candidate.cleanup.stale_detected_at;
  saveState(candidate);
  const stopped = [];

  const result = waitMailbox(state.runId, {
    ceilingSec: 1,
    stopTmux: session => stopped.push(session),
  });

  assert.equal(result.classified.status, "watching");
  assert.equal(loadState(state.runId).status, "watching");
  assert.deepEqual(stopped, []);
}));

test("mark_stale stores tmux session id from first inspection without second lookup", withTempRuns(async () => {
  const state = createGcFixture({ typed: true });
  let inspectCalls = 0;

  gcRuns({
    now: new Date(NOW),
    states: [loadState(state.runId)],
    heartbeatFor: () => NOW - IDLE_MS - 1,
    inspectTmux: session => {
      inspectCalls += 1;
      const staleActivity = NOW - IDLE_MS - 1;
      if (inspectCalls === 1) {
        return { exists: true, activityMs: staleActivity, sessionId: "$old" };
      }
      return { exists: true, activityMs: staleActivity, sessionId: "$replacement" };
    },
    stopTmux: () => assert.fail("mark_stale must not stop"),
    releaseLease: () => assert.fail("mark_stale must not release"),
  });

  const latest = loadState(state.runId);
  assert.equal(latest.cleanup?.worker_tmux_id, "$old");
  assert.equal(latest.cleanup?.stale_detected_at, new Date(NOW).toISOString());
  assert.equal(inspectCalls, 1);
}));

test("identity mismatch at final confirmation clears candidate and never stops replacement", withTempRuns(async () => {
  const state = staleCandidateFixture({ typed: true });
  const candidate = loadState(state.runId);
  candidate.cleanup.worker_tmux_id = "$old";
  saveState(candidate);
  const stopped = [];
  let inspectCalls = 0;

  gcRuns({
    ...staleDeps,
    states: [loadState(state.runId)],
    inspectTmux: session => {
      inspectCalls += 1;
      const staleActivity = NOW - IDLE_MS - 1;
      if (inspectCalls === 1) {
        return { exists: true, activityMs: staleActivity, sessionId: "$old" };
      }
      return { exists: true, activityMs: staleActivity, sessionId: "$replacement" };
    },
    releaseLease: () => assert.fail("identity mismatch must not release"),
    stopTmux: session => stopped.push(session),
  });

  const latest = loadState(state.runId);
  assert.equal(latest.status, "watching");
  assert.equal(latest.cleanup?.stale_detected_at, undefined);
  assert.equal(latest.cleanup?.stale_publication_claim, undefined);
  assert.deepEqual(stopped, []);
}));
