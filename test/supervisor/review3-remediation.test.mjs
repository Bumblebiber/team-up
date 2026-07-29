import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, loadState, saveState, runDir, setStatus } from "../../src/runs/runs.mjs";
import {
  createAttempt,
  acquireAttemptLease,
  releaseAttemptLease,
  reclaimStaleLease,
  readLease,
} from "../../src/supervisor/attempts.mjs";
import {
  buildLaunchDescriptor,
  persistLaunchDescriptor,
  loadAuthoritativeLaunchDescriptor,
  prepareArgvFromDescriptor,
  startFromLaunchDescriptor,
  LAUNCH_REF_SCHEMA,
} from "../../src/supervisor/start.mjs";
import { decideTransition, executeTransition } from "../../src/supervisor/controller.mjs";
import {
  listSupervisedRuns,
  ingestMailboxHeartbeat,
  buildProductionSuperviseDeps,
} from "../../src/supervisor/production.mjs";
import { recheckCapacity } from "../../src/supervisor/waits.mjs";
import { watcherSleepSec } from "../../src/usage/usage-watcher.mjs";
import { evaluateNativeShellFromStream } from "../../src/harness/cli-verify.mjs";
import { getAdapter } from "../../src/harness/registry.mjs";
import { execFileSync } from "node:child_process";

function withTempEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r3-"));
  const prev = {
    TEAM_UP_HOME: process.env.TEAM_UP_HOME,
    TEAM_UP_RUNS: process.env.TEAM_UP_RUNS,
    TEAM_UP_ROSTER: process.env.TEAM_UP_ROSTER,
    TEAM_UP_USAGE: process.env.TEAM_UP_USAGE,
    TEAM_UP_SANDBOX_FORCE_NONE: process.env.TEAM_UP_SANDBOX_FORCE_NONE,
  };
  process.env.TEAM_UP_HOME = home;
  process.env.TEAM_UP_RUNS = path.join(home, "runs");
  process.env.TEAM_UP_ROSTER = path.join(home, "roster.json");
  process.env.TEAM_UP_USAGE = path.join(home, "usage.json");
  process.env.TEAM_UP_SANDBOX_FORCE_NONE = "1";
  fs.writeFileSync(
    process.env.TEAM_UP_ROSTER,
    JSON.stringify({
      accounts: { anthropic: { kind: "subscription", enabled: true } },
      clis: {
        claude: {
          cmd: ["true", "{prompt}"],
        },
      },
      models: {
        m1: {
          tier: "frontier",
          cli: ["claude"],
          account: "anthropic",
          provider: "anthropic",
          reasoning: { max: null },
          priority: 1,
          limit_windows: ["claude:5h"],
        },
        m2: {
          tier: "frontier",
          cli: ["claude"],
          account: "anthropic",
          provider: "anthropic",
          reasoning: { max: null },
          priority: 2,
          limit_windows: ["claude:7d"],
        },
      },
      limits: { handoff_at: 0.95 },
    })
  );
  fs.writeFileSync(process.env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(home, { recursive: true, force: true });
    });
}

function makeDescriptor(runId, overrides = {}) {
  const rd = runDir(runId);
  const promptPath = path.join(rd, "mailbox", "PROMPT.md");
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, "do work\n");
  const contextDir = path.join(rd, "context");
  fs.mkdirSync(contextDir, { recursive: true });
  const policySnap = path.join(rd, "policy", "commands.snapshot.json");
  fs.mkdirSync(path.dirname(policySnap), { recursive: true });
  fs.writeFileSync(policySnap, "{}\n");
  return buildLaunchDescriptor({
    cli: "claude",
    model: "m1",
    promptPath,
    contextDir,
    project: "/tmp",
    permissions: { filesystem: "project_readonly", writes: false, network: false, commands: ["project-test"] },
    callType: "consult",
    broker: {
      policySnapshot: policySnap,
      policyChecksum: "sha256:abc",
      project: "/tmp",
      runDir: rd,
      actionIds: ["project-test"],
    },
    harnessRequirements: { command_broker: "team-up.command-broker/v1" },
    harnessVerification: {
      status: "verified",
      adapter: "claude",
      cli_version: getAdapter("claude").version({ execFileSync }),
      command_broker: "team-up.command-broker/v1",
      context_isolation: null,
    },
    specialistProfile: { tier: "frontier", reasoning: "max" },
    limitWindows: ["claude:5h"],
    specialist: { id: "testing.r3", version: "0.1.0" },
    ...overrides,
  });
}

test("STATE.json mutation of broker cannot change authoritative prepared argv", async () => {
  await withTempEnv(async (home) => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:r3",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const desc = makeDescriptor(run.runId);
    persistLaunchDescriptor(run.runId, desc);
    const st = loadState(run.runId);
    assert.equal(st.launch_descriptor?.schema, LAUNCH_REF_SCHEMA);
    assert.ok(st.launch_descriptor?.checksum);
    assert.equal(st.launch_descriptor?.broker, undefined);

    const before = prepareArgvFromDescriptor(
      loadAuthoritativeLaunchDescriptor(run.runId)
    );
    assert.ok(before.argv.includes("--disallowedTools") || before.argv.some((a) => String(a).includes("Bash")));

    // Worker mutates STATE.json — remove broker fields from any embedded copy.
    st.launch_descriptor = {
      ...desc,
      broker: null,
      harness_requirements: {},
    };
    saveState(st);

    const after = prepareArgvFromDescriptor(
      loadAuthoritativeLaunchDescriptor(run.runId)
    );
    assert.deepEqual(after.argv, before.argv);
    assert.ok(
      after.argv.includes("--disallowedTools") ||
        after.argv.some((a) => /Bash/.test(String(a)))
    );

    // Corrupt authoritative file → fail closed
    const authPath = path.join(home, "launch-descriptors", run.runId, "descriptor.json");
    fs.chmodSync(authPath, 0o644);
    fs.writeFileSync(authPath, "{corrupt");
    assert.throws(
      () => loadAuthoritativeLaunchDescriptor(run.runId),
      /LAUNCH_DESCRIPTOR/
    );
  });
});

test("missing broker when command_broker required fails closed (no raw argv)", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:r3",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const desc = makeDescriptor(run.runId, { broker: null });
    persistLaunchDescriptor(run.runId, desc);
    assert.throws(
      () =>
        prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(run.runId)),
      /BROKER|FAIL|command_broker|HARNESS/i
    );
  });
});

test("start with missing/released lease performs no TMUX call", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:r3",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    persistLaunchDescriptor(run.runId, makeDescriptor(run.runId));
    const attempt = createAttempt({
      runId: run.runId,
      runtime: { cli: "claude", model: "m1" },
    });
    let tmuxCalls = 0;
    await assert.rejects(
      async () =>
        startFromLaunchDescriptor({
          runId: run.runId,
          attempt,
          startTmux: () => {
            tmuxCalls++;
          },
        }),
      /LEASE/
    );
    assert.equal(tmuxCalls, 0);

    acquireAttemptLease({
      runId: run.runId,
      attemptId: attempt.id,
      expectedPrevious: null,
    });
    releaseAttemptLease({
      runId: run.runId,
      attemptId: attempt.id,
      reason: "released",
    });
    await assert.rejects(
      async () =>
        startFromLaunchDescriptor({
          runId: run.runId,
          attempt,
          startTmux: () => {
            tmuxCalls++;
          },
        }),
      /LEASE/
    );
    assert.equal(tmuxCalls, 0);
  });
});

test("transfer failure kills spawned session and leaves no watching state", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:r3",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    persistLaunchDescriptor(run.runId, makeDescriptor(run.runId));
    const killed = [];
    const sessions = [];

    const attempt = createAttempt({
      runId: run.runId,
      runtime: { cli: "claude", model: "m1" },
    });
    acquireAttemptLease({
      runId: run.runId,
      attemptId: attempt.id,
      expectedPrevious: null,
      owner: `starting:pid:${process.pid}`,
    });

    await assert.rejects(
      async () =>
        startFromLaunchDescriptor({
          runId: run.runId,
          attempt,
          sessionName: "team-up-transfer-fail",
          startTmux: ({ session }) => {
            sessions.push(session);
          },
          killTmux: (session) => {
            killed.push(session);
          },
          transferOwner: () => ({ ok: false, reason: "already_released" }),
        }),
      /LEASE_TRANSFER|transfer/i
    );
    assert.equal(sessions.length, 1);
    assert.deepEqual(killed, sessions);
    const st = loadState(run.runId);
    assert.notEqual(st.status, "watching");
  });
});

test("controller retry reacquires lease and launches at most one successor", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:r3",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const a1 = createAttempt({
      runId: run.runId,
      runtime: { cli: "claude", model: "m1" },
    });
    acquireAttemptLease({ runId: run.runId, attemptId: a1.id });
    const st = loadState(run.runId);
    st.current_attempt_id = a1.id;
    saveState(st);

    let starts = 0;
    let acquires = 0;
    const result = await executeTransition(
      {
        action: "complete_handoff",
        runId: run.runId,
        now: "2026-07-25T18:00:00Z",
        release: { runId: run.runId, attemptId: a1.id },
        tmuxSession: "old",
        checkpoint: {
          schema: "team-up.checkpoint/v1",
          status: "complete",
          run_id: run.runId,
          attempt_id: a1.id,
          completed: [],
          open: [],
          artifacts: [],
          verification_commands: [],
          risks: [],
          questions: [],
        },
      },
      {
        validateCheckpoint: () => ({ ok: true }),
        releaseLease: async (t) => {
          if (t?.attemptId) {
            releaseAttemptLease({
              runId: run.runId,
              attemptId: t.attemptId,
              reason: "handoff",
            });
          } else if (t?.id) {
            releaseAttemptLease({
              runId: run.runId,
              attemptId: t.id,
              reason: "start_failed",
            });
          }
        },
        stopTmux: async () => {},
        refreshUsage: async () => {},
        resolveChain: async () => ({ chain: [{ cli: "claude", model: "m2" }] }),
        createAttempt: async (cell) =>
          createAttempt({ runId: run.runId, runtime: cell }),
        acquireLease: async (next) => {
          acquires++;
          const prev = loadState(run.runId).current_attempt_id;
          return acquireAttemptLease({
            runId: run.runId,
            attemptId: next.id,
            expectedPrevious: prev,
            owner: `starting:pid:${process.pid}`,
          });
        },
        startWorker: async (next) => {
          starts++;
          if (starts === 1) {
            // Simulate start path releasing lease on failure
            releaseAttemptLease({
              runId: run.runId,
              attemptId: next.id,
              reason: "start_failed",
            });
            throw new Error("spawn boom");
          }
          const lease = readLease(run.runId);
          assert.equal(lease?.attempt_id, next.id);
          assert.equal(lease?.released_at, null);
        },
        persistState: async () => {},
        appendEvent: async () => {},
        notifyMailbox: async () => {},
        maxStartRetries: 2,
      }
    );
    assert.equal(result.ok, true);
    assert.equal(starts, 2);
    assert.ok(acquires >= 2, `expected reacquire, got ${acquires}`);
    const lease = readLease(run.runId);
    assert.equal(lease.released_at, null);
  });
});

test("fresh mailbox heartbeat protects >10min run; stale heartbeat reclaims", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:r3",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const attempt = createAttempt({
      runId: run.runId,
      runtime: { cli: "claude", model: "m1" },
      now: "2026-07-25T16:00:00Z",
    });
    acquireAttemptLease({
      runId: run.runId,
      attemptId: attempt.id,
      now: "2026-07-25T16:00:00Z",
      owner: "tmux:alive-session",
      expiresAt: null,
    });
    const st = loadState(run.runId);
    st.status = "watching";
    st.supervision = { enabled: true, lease_stale_seconds: 600 };
    st.current_attempt_id = attempt.id;
    st.worker = { tmux: "alive-session", cli: "claude", model: "m1" };
    st.heartbeat_at = "2026-07-25T16:00:00Z";
    saveState(st);

    const mb = path.join(runDir(run.runId), "mailbox");
    fs.mkdirSync(mb, { recursive: true });
    fs.writeFileSync(path.join(mb, "HEARTBEAT"), "2026-07-25T16:11:00Z\n");

    ingestMailboxHeartbeat(run.runId, { now: "2026-07-25T16:11:30Z" });
    const kept = reclaimStaleLease({
      runId: run.runId,
      now: "2026-07-25T16:11:30Z",
      maxAgeMs: 600_000,
    });
    assert.equal(kept.ok, false, "fresh mailbox hb must retain lease");

    fs.writeFileSync(path.join(mb, "HEARTBEAT"), "2026-07-25T15:00:00Z\n");
    ingestMailboxHeartbeat(run.runId, { now: "2026-07-25T16:12:00Z" });
    const reclaimed = reclaimStaleLease({
      runId: run.runId,
      now: "2026-07-25T16:12:00Z",
      maxAgeMs: 600_000,
    });
    assert.equal(reclaimed.ok, true);
    assert.equal(reclaimed.reason, "heartbeat_stale");

    // Malformed heartbeat must not be eternally fresh
    const a2 = createAttempt({
      runId: run.runId,
      runtime: { cli: "claude", model: "m1" },
      now: "2026-07-25T16:12:01Z",
    });
    acquireAttemptLease({
      runId: run.runId,
      attemptId: a2.id,
      expectedPrevious: attempt.id,
      now: "2026-07-25T16:00:00Z",
      owner: "tmux:alive-session",
      expiresAt: null,
    });
    const stFix = loadState(run.runId);
    stFix.current_attempt_id = a2.id;
    saveState(stFix);
    fs.writeFileSync(path.join(mb, "HEARTBEAT"), "not-a-timestamp\n");
    const ingested = ingestMailboxHeartbeat(run.runId, {
      now: "2026-07-25T16:20:00Z",
    });
    assert.equal(ingested.ok, false);
    const st2 = loadState(run.runId);
    assert.notEqual(st2.mailbox_heartbeat_at, "not-a-timestamp");
  });
});

test("complete/partial checkpoint without handoff_ready remains observe below 95%", () => {
  assert.equal(
    decideTransition({
      state: "handoff_preparing",
      used: 0.93,
      prepareAt: 0.9,
      forceAt: 0.95,
      heartbeatFresh: true,
      processAlive: true,
      checkpoint: {
        schema: "team-up.checkpoint/v1",
        status: "complete",
        completed: [],
        open: [],
        artifacts: [],
        verification_commands: [],
        risks: [],
        questions: [],
      },
      handoffReady: false,
    }).action,
    "observe"
  );
  assert.equal(
    decideTransition({
      state: "handoff_preparing",
      used: 0.93,
      prepareAt: 0.9,
      forceAt: 0.95,
      heartbeatFresh: true,
      processAlive: true,
      checkpoint: {
        schema: "team-up.checkpoint/v1",
        status: "partial",
        completed: [],
        open: ["x"],
        artifacts: [],
        verification_commands: [],
        risks: [],
        questions: [],
      },
      handoffReady: true,
    }).action,
    "complete_handoff"
  );
});

test("usage refresh result changes successor selection in same transition", async () => {
  await withTempEnv(async () => {
    let usageDoc = { windows: { "claude:5h": { used: 0.99 } } };
    const chainCalls = [];
    const result = await executeTransition(
      {
        action: "force_handoff",
        runId: "run-x",
        now: "2026-07-25T18:00:00Z",
        release: { runId: "run-x", attemptId: "a1" },
        tmuxSession: "s",
        excludeCandidate: { cli: "claude", model: "m1" },
      },
      {
        releaseLease: async () => {},
        stopTmux: async () => {},
        materializePartialCheckpoint: () => ({
          schema: "team-up.checkpoint/v1",
          status: "partial",
        }),
        refreshUsage: async () => {
          usageDoc = { windows: { "claude:5h": { used: 0.1 }, "claude:7d": { used: 0.1 } } };
        },
        resolveChain: async () => {
          chainCalls.push(structuredClone(usageDoc));
          if (usageDoc.windows["claude:5h"].used > 0.9) {
            return { chain: [], capacity_report: { blocked_candidates: [], next_reset_at: null } };
          }
          return { chain: [{ cli: "claude", model: "m2" }] };
        },
        createAttempt: async (cell) => ({ id: "a2", runtime: cell }),
        acquireLease: async () => ({ ok: true }),
        startWorker: async () => {},
        persistState: async () => {},
        appendEvent: async () => {},
        notifyMailbox: async () => {},
        persistCapacityReport: async () => {},
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, "force_handoff");
    assert.equal(chainCalls.length, 1);
    assert.ok(chainCalls[0].windows["claude:5h"].used < 0.9);
  });
});

test("watcher tick capped at 60s only when supervised runs exist", () => {
  assert.equal(watcherSleepSec({ tick_sec: 300 }, { supervisedCount: 0 }), 300);
  assert.equal(watcherSleepSec({ tick_sec: 300 }, { supervisedCount: 2 }), 60);
  assert.equal(watcherSleepSec({ tick_sec: 30 }, { supervisedCount: 1 }), 30);
});

test("alternate-model wait resume keeps descriptor intact until validated start", async () => {
  await withTempEnv(async (home) => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:r3",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    persistLaunchDescriptor(run.runId, makeDescriptor(run.runId));
    const before = loadAuthoritativeLaunchDescriptor(run.runId);
    const st = loadState(run.runId);
    st.status = "waiting_capacity";
    st.capacity = {
      auto_resume: true,
      wait_cancelled: false,
      next_reset_at: "2026-07-25T10:00:00Z",
    };
    st.runtime = { cli: "claude", model: "m1", limit_windows: ["claude:5h"] };
    saveState(st);

    const roster = JSON.parse(fs.readFileSync(process.env.TEAM_UP_ROSTER, "utf8"));
    const usage = { windows: {} };
    const started = [];
    await recheckCapacity({
      runId: run.runId,
      usage,
      roster,
      profileResult: {
        chain: [{ cli: "claude", model: "m2", effort: null }],
      },
      now: "2026-07-25T18:00:00Z",
      startWorker: async ({ attempt }) => {
        started.push(attempt);
        // Production wires this to startFromLaunchDescriptor({ runtimeOverride }).
        // recheckCapacity itself must not mutate the authoritative descriptor.
      },
    });
    assert.equal(started.length, 1);
    assert.deepEqual(started[0].runtime?.limit_windows, ["claude:7d"]);
    assert.equal(started[0].runtime?.model, "m2");
    const auth = loadAuthoritativeLaunchDescriptor(run.runId);
    assert.equal(auth.model, before.model);
    assert.deepEqual(auth.limit_windows, before.limit_windows);
    void home;
  });
});

test("Claude text NATIVE_SHELL_DENIED without structured tool evidence remains unverified", () => {
  const r = evaluateNativeShellFromStream({
    events: [],
    text: "NATIVE_SHELL_DENIED",
  });
  assert.equal(r, "unverified");

  const denied = evaluateNativeShellFromStream({
    events: [
      { type: "tool_use", name: "Bash", error: "disallowed" },
    ],
    text: "whatever",
  });
  assert.equal(denied, "denied");

  const allowed = evaluateNativeShellFromStream({
    events: [
      { type: "tool_use", name: "Bash", input: { command: "echo x" }, result: "x" },
    ],
    text: "",
  });
  assert.equal(allowed, "allowed");
});

test("production refreshUsage is not a silent no-op", async () => {
  await withTempEnv(async () => {
    let called = false;
    const deps = buildProductionSuperviseDeps({
      now: "2026-07-25T18:00:00Z",
      refreshUsageImpl: async () => {
        called = true;
      },
    });
    await deps.refreshUsage();
    assert.equal(called, true);
  });
});

test("listSupervisedRuns persists draft checkpoint but plans observe without ready", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:r3",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const a1 = createAttempt({
      runId: run.runId,
      runtime: { cli: "claude", model: "m1" },
    });
    acquireAttemptLease({
      runId: run.runId,
      attemptId: a1.id,
      owner: "tmux:sess",
    });
    const st = loadState(run.runId);
    st.status = "handoff_preparing";
    st.supervision = { enabled: true };
    st.current_attempt_id = a1.id;
    st.worker = { tmux: "sess", cli: "claude", model: "m1" };
    st.usage_used = 0.93;
    saveState(st);

    const mb = path.join(runDir(run.runId), "mailbox");
    fs.mkdirSync(mb, { recursive: true });
    const cp = {
      schema: "team-up.checkpoint/v1",
      status: "complete",
      run_id: run.runId,
      attempt_id: a1.id,
      summary: "draft complete",
      completed: ["a"],
      open: [],
      artifacts: [],
      verification_commands: [],
      risks: [],
      questions: [],
      repository: { head: null, dirty: null, diff_stat: null },
      created_at: "2026-07-25T18:00:00Z",
    };
    fs.writeFileSync(path.join(mb, "CHECKPOINT.json"), JSON.stringify(cp));
    fs.writeFileSync(path.join(mb, "CONTROL.json"), JSON.stringify({ handoff_ready: false }));

    const now = new Date().toISOString();
    const listed = listSupervisedRuns({
      now,
      usage: { windows: {} },
      processAliveOverride: () => true,
    });
    const row = listed.find((r) => r.runId === run.runId);
    assert.ok(row);
    assert.equal(row.handoffReady, false);
    // Exposed for planning only when ready — or null/undefined for transition
    assert.equal(row.checkpointForTransition, null);
    assert.equal(row.checkpoint?.status, "complete");
    const live = loadState(run.runId);
    assert.equal(live.checkpoint?.status, "complete");
    const decision = decideTransition({
      state: "handoff_preparing",
      used: 0.93,
      prepareAt: 0.9,
      forceAt: 0.95,
      heartbeatFresh: true,
      processAlive: true,
      checkpoint: row.checkpointForTransition,
      handoffReady: row.handoffReady,
    });
    assert.equal(decision.action, "observe");
  });
});
