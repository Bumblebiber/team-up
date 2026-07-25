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
  listAttempts,
} from "../../src/supervisor/attempts.mjs";
import {
  decideTransition,
  executeTransition,
  superviseActiveRuns,
} from "../../src/supervisor/controller.mjs";
import {
  approveCapacityWait,
  cancelCapacityWait,
  resumeDueWaits,
  listDueWaits,
} from "../../src/supervisor/waits.mjs";
import { snapshotCommandPolicy, commandPolicyChecksum } from "../../src/commands/policy.mjs";
import { createBrokerServer } from "../../src/commands/mcp-server.mjs";
import { afterUsageCollectSupervise } from "../../src/usage/usage-watcher.mjs";

function withTempEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-prod-"));
  const prev = {
    TEAM_UP_HOME: process.env.TEAM_UP_HOME,
    TEAM_UP_RUNS: process.env.TEAM_UP_RUNS,
  };
  process.env.TEAM_UP_HOME = home;
  process.env.TEAM_UP_RUNS = path.join(home, "runs");
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      if (prev.TEAM_UP_HOME === undefined) delete process.env.TEAM_UP_HOME;
      else process.env.TEAM_UP_HOME = prev.TEAM_UP_HOME;
      if (prev.TEAM_UP_RUNS === undefined) delete process.env.TEAM_UP_RUNS;
      else process.env.TEAM_UP_RUNS = prev.TEAM_UP_RUNS;
      fs.rmSync(home, { recursive: true, force: true });
    });
}

test("production launch path records attempt+lease without test-only composition", async () => {
  await withTempEnv(async () => {
    const { beginSupervisedAttempt } = await import("../../src/supervisor/production.mjs");
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:testing.hannes",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "frontier-claude" },
      prompt: "hi",
    });
    const attempt = beginSupervisedAttempt({
      runId: run.runId,
      runtime: { cli: "claude", model: "frontier-claude" },
      specialist: { id: "testing.hannes", version: "0.1.0" },
    });
    const st = loadState(run.runId);
    assert.equal(st.supervision?.enabled, true);
    assert.equal(st.current_attempt_id, attempt.id);
    assert.equal(listAttempts(run.runId).length, 1);
    assert.equal(st.status, "watching");
  });
});

test("usage watcher entrypoint invokes superviseActiveRuns after collect", async () => {
  await withTempEnv(async () => {
    let called = false;
    const deps = {
      listSupervisedRuns: async () => {
        called = true;
        return [];
      },
    };
    await afterUsageCollectSupervise({ now: "2026-07-25T16:00:00Z", deps });
    assert.equal(called, true);
  });
});

test("superviseActiveRuns crosses 90 and 95 thresholds for a fake worker", async () => {
  await withTempEnv(async () => {
    const events = [];
    const started = [];
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:x",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const a1 = createAttempt({
      runId: run.runId,
      runtime: { cli: "claude", model: "m1" },
    });
    assert.equal(acquireAttemptLease({ runId: run.runId, attemptId: a1.id }).ok, true);
    setStatus(run.runId, "watching");
    const st = loadState(run.runId);
    st.status = "running";
    st.supervision = { enabled: true };
    saveState(st);

    const baseDeps = {
      writeControl: async (msg) => events.push(["control", msg]),
      injectControl: async (msg) => events.push(["inject", msg]),
      appendEvent: async (e) => events.push(["event", e]),
      notifyMailbox: async (m) => events.push(["mailbox", m]),
      validateCheckpoint: () => ({ ok: true }),
      releaseLease: async (target) => {
        events.push(["release", target]);
        if (target?.attemptId) {
          releaseAttemptLease({
            runId: run.runId,
            attemptId: target.attemptId,
            reason: "handoff",
          });
        } else if (target?.id) {
          releaseAttemptLease({
            runId: run.runId,
            attemptId: target.id,
            reason: "start_failed",
          });
        }
      },
      stopTmux: async () => events.push(["stop"]),
      refreshUsage: async () => {},
      resolveChain: async () => ({ chain: [{ cli: "claude", model: "m2" }] }),
      createAttempt: async (cell) => {
        const next = createAttempt({
          runId: run.runId,
          runtime: cell,
        });
        events.push(["attempt", next.id]);
        return next;
      },
      acquireLease: async (next) => {
        const prev = loadState(run.runId).current_attempt_id;
        return acquireAttemptLease({
          runId: run.runId,
          attemptId: next.id,
          expectedPrevious: prev,
        });
      },
      startWorker: async (next) => {
        started.push(next.id);
        const s = loadState(run.runId);
        s.status = "running";
        saveState(s);
      },
    };

    const at90 = await superviseActiveRuns({
      now: "2026-07-25T16:00:00Z",
      deps: {
        ...baseDeps,
        listSupervisedRuns: async () => [
          {
            runId: run.runId,
            state: "running",
            used: 0.9,
            prepareAt: 0.9,
            forceAt: 0.95,
            heartbeatFresh: true,
            processAlive: true,
            capacityAvailable: true,
          },
        ],
      },
    });
    assert.equal(at90[0].decision.action, "request_handoff");
    assert.ok(events.some((e) => e[0] === "inject"));

    events.length = 0;
    const at95 = await superviseActiveRuns({
      now: "2026-07-25T16:01:00Z",
      deps: {
        ...baseDeps,
        listSupervisedRuns: async () => [
          {
            runId: run.runId,
            state: "handoff_preparing",
            used: 0.95,
            prepareAt: 0.9,
            forceAt: 0.95,
            heartbeatFresh: true,
            processAlive: true,
            capacityAvailable: true,
            checkpoint: null,
            release: { runId: run.runId, attemptId: a1.id },
            tmuxSession: "fake",
          },
        ],
      },
    });
    assert.equal(at95[0].decision.action, "force_handoff");
    assert.equal(at95[0].result.ok, true);
    assert.equal(started.length, 1);
    assert.ok(listAttempts(run.runId).length >= 2);
  });
});

test("due capacity wait resume launches a successor worker", async () => {
  await withTempEnv(async () => {
    const started = [];
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:x",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    approveCapacityWait({
      runId: run.runId,
      nextResetAt: "2026-07-25T18:00:00Z",
      now: "2026-07-25T17:00:00Z",
    });
    assert.deepEqual(listDueWaits({ now: "2026-07-25T18:00:01Z" }), [run.runId]);

    const roster = {
      models: {
        m1: { provider: "anthropic", limit_windows: ["claude:5h"] },
      },
      limits: { handoff_at: 0.95 },
    };
    const usage = { windows: {} };
    const results = await resumeDueWaits({
      now: "2026-07-25T18:00:01Z",
      usage,
      roster,
      profileResult: { chain: [{ cli: "claude", model: "m1" }] },
      startWorker: async ({ attempt }) => {
        started.push(attempt.id);
      },
    });
    assert.equal(results[0].ok, true);
    assert.equal(results[0].resumed, true);
    assert.equal(started.length, 1);
    assert.equal(loadState(run.runId).status, "watching");
  });
});

test("human cancel suppresses auto-resume and preserves run", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:x",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude" },
      prompt: "hi",
    });
    approveCapacityWait({
      runId: run.runId,
      nextResetAt: "2026-07-25T18:00:00Z",
      now: "2026-07-25T17:00:00Z",
    });
    cancelCapacityWait({ runId: run.runId, reason: "human" });
    const results = await resumeDueWaits({
      now: "2026-07-25T18:00:01Z",
      usage: {},
      roster: { models: {} },
      profileResult: { chain: [{ cli: "claude", model: "m1" }] },
      startWorker: async () => {
        throw new Error("should not start");
      },
    });
    assert.equal(results.length, 0);
    assert.equal(loadState(run.runId).capacity.auto_resume, false);
    assert.equal(fs.existsSync(runDir(run.runId)), true);
  });
});

test("mutating worker-visible policy copy cannot widen broker actions", async () => {
  await withTempEnv(async (home) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pol-"));
    const run = createRun({
      cwd: project,
      project,
      role: "specialist:x",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude" },
      prompt: "hi",
    });
    const policy = {
      schema_version: 1,
      commands: {
        "project-test": {
          argv: [process.execPath, "-e", "process.stdout.write('ok')"],
          cwd: ".",
          timeout_seconds: 10,
          environment: {},
        },
      },
    };
    const checksum = commandPolicyChecksum(policy);
    const snap = snapshotCommandPolicy({
      policy,
      runId: run.runId,
      workerVisibleDir: path.join(runDir(run.runId), "policy"),
    });
    assert.ok(snap.path.startsWith(path.join(home, "policy-snapshots")));
    assert.equal(snap.checksum, checksum);

    // Worker mutates visible copy to add a dangerous action.
    const visible = path.join(runDir(run.runId), "policy", "commands.json");
    assert.equal(fs.existsSync(visible), true);
    const widened = {
      schema_version: 1,
      commands: {
        ...policy.commands,
        "rm-rf": {
          argv: [process.execPath, "-e", "process.stdout.write('pwned')"],
          cwd: ".",
          timeout_seconds: 10,
          environment: {},
        },
      },
    };
    fs.chmodSync(visible, 0o644);
    fs.writeFileSync(visible, JSON.stringify(widened));

    const { server, tools } = createBrokerServer({
      policyPath: snap.path,
      project,
      runDir: runDir(run.runId),
      expectedChecksum: checksum,
    });
    assert.deepEqual(
      tools.map((t) => t.actionId),
      ["project-test"]
    );
    assert.ok(!tools.some((t) => t.actionId === "rm-rf"));
    // Force checksum mismatch against mutated authoritative file should deny.
    fs.chmodSync(snap.path, 0o644);
    fs.writeFileSync(snap.path, JSON.stringify(widened));
    await assert.rejects(
      async () =>
        createBrokerServer({
          policyPath: snap.path,
          project,
          runDir: runDir(run.runId),
          expectedChecksum: checksum,
        }),
      /POLICY_CHECKSUM_MISMATCH|COMMAND_POLICY/
    );
    void server;
    fs.rmSync(project, { recursive: true, force: true });
  });
});

test("decideTransition still plans 90/95 without injection", () => {
  assert.equal(
    decideTransition({
      state: "running",
      used: 0.9,
      prepareAt: 0.9,
      forceAt: 0.95,
      heartbeatFresh: true,
      processAlive: true,
    }).action,
    "request_handoff"
  );
  assert.equal(
    decideTransition({
      state: "running",
      used: 0.95,
      prepareAt: 0.9,
      forceAt: 0.95,
      heartbeatFresh: true,
      processAlive: true,
    }).action,
    "force_handoff"
  );
});

test("executeTransition releases lease when startWorker throws", async () => {
  const released = [];
  const next = { id: "a0002" };
  const result = await executeTransition(
    { action: "force_handoff", now: "2026-07-25T16:00:00Z", release: { attemptId: "a0001" } },
    {
      validateCheckpoint: () => ({ ok: true }),
      releaseLease: async (x) => released.push(x),
      stopTmux: async () => {},
      refreshUsage: async () => {},
      resolveChain: async () => ({ chain: [{ cli: "claude", model: "m2" }] }),
      createAttempt: async () => next,
      acquireLease: async () => ({ ok: true, lease: { attempt_id: next.id } }),
      startWorker: async () => {
        throw new Error("tmux boom");
      },
      appendEvent: async () => {},
      notifyMailbox: async () => {},
    }
  );
  assert.equal(result.ok, false);
  assert.ok(released.some((r) => r?.attemptId === next.id || r?.id === next.id || r === next));
});
