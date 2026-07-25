import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, loadState, saveState, runDir } from "../../src/runs/runs.mjs";
import {
  createAttempt,
  acquireAttemptLease,
  readLease,
} from "../../src/supervisor/attempts.mjs";
import {
  buildLaunchDescriptor,
  persistLaunchDescriptor,
  loadAuthoritativeLaunchDescriptor,
} from "../../src/supervisor/start.mjs";
import { decideTransition, executeTransition } from "../../src/supervisor/controller.mjs";
import {
  buildProductionSuperviseDeps,
  listSupervisedRuns,
} from "../../src/supervisor/production.mjs";
import { recheckCapacity } from "../../src/supervisor/waits.mjs";
import {
  evaluateNativeShellFromStream,
  parseClaudeStreamEvents,
  decideBrokerToolFromEvidence,
} from "../../src/harness/cli-verify.mjs";

function withTempEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r4-"));
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
    permissions: {
      filesystem: "project_readonly",
      writes: false,
      network: false,
      commands: ["project-test"],
    },
    callType: "consult",
    broker: {
      policySnapshot: policySnap,
      policyChecksum: "sha256:abc",
      project: "/tmp",
      runDir: rd,
      actionIds: ["project-test"],
    },
    harnessRequirements: { command_broker: "team-up.command-broker/v1" },
    specialistProfile: { tier: "frontier", reasoning: "max" },
    limitWindows: ["claude:5h"],
    specialist: { id: "testing.r4", version: "0.1.0" },
    ...overrides,
  });
}

test("Claude prose denial sentinel without stream evidence stays unverified", () => {
  const prose =
    "Bash is unavailable or denied by policy. NATIVE_SHELL_DENIED. I will not invent tools.";
  const events = parseClaudeStreamEvents(prose);
  assert.equal(events.length, 0);
  assert.equal(
    evaluateNativeShellFromStream({ events, text: prose }),
    "unverified"
  );
});

test("broker output with surrounding prose is unverified; exact trimmed ok + audit passes", () => {
  assert.equal(
    decideBrokerToolFromEvidence({
      stdout: "explanation\nok",
      freshAudit: true,
      auditOk: true,
    }),
    "unverified"
  );
  assert.equal(
    decideBrokerToolFromEvidence({
      stdout: "ok\nextra",
      freshAudit: true,
      auditOk: true,
    }),
    "unverified"
  );
  assert.equal(
    decideBrokerToolFromEvidence({
      stdout: "ok",
      freshAudit: true,
      auditOk: true,
    }),
    "passed"
  );
  assert.equal(
    decideBrokerToolFromEvidence({
      stdout: "  ok\n",
      freshAudit: true,
      auditOk: true,
    }),
    "passed"
  );
  assert.equal(
    decideBrokerToolFromEvidence({
      stdout: "ok",
      freshAudit: false,
      auditOk: true,
    }),
    "unverified"
  );
});

test("refresh {ok:false} keeps old lease/TMUX; no successor; records retryable failure", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:r4",
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
      owner: "tmux:old-live",
    });
    const st = loadState(run.runId);
    st.current_attempt_id = a1.id;
    st.worker = { tmux: "old-live", cli: "claude", model: "m1" };
    st.status = "handing_off";
    saveState(st);

    let released = false;
    let stopped = false;
    let resolved = false;
    let started = false;
    const persisted = [];

    const result = await executeTransition(
      {
        action: "complete_handoff",
        runId: run.runId,
        now: "2026-07-25T18:00:00Z",
        release: { runId: run.runId, attemptId: a1.id },
        tmuxSession: "old-live",
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
        releaseLease: async () => {
          released = true;
        },
        stopTmux: async () => {
          stopped = true;
        },
        refreshUsage: async () => ({ ok: false, error: "USAGE_REFRESH_FAILED: boom" }),
        resolveChain: async () => {
          resolved = true;
          return { chain: [{ cli: "claude", model: "m2" }] };
        },
        createAttempt: async () => {
          throw new Error("should not create");
        },
        acquireLease: async () => ({ ok: true }),
        startWorker: async () => {
          started = true;
        },
        persistState: async (patch) => {
          persisted.push(patch);
        },
        appendEvent: async () => {},
        notifyMailbox: async () => {},
      }
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, "usage_refresh_failed");
    assert.equal(released, false);
    assert.equal(stopped, false);
    assert.equal(resolved, false);
    assert.equal(started, false);
    assert.ok(
      persisted.some(
        (p) =>
          p.failure?.retryable === true ||
          p.supervision_failure?.retryable === true ||
          p.last_error?.includes?.("USAGE_REFRESH") ||
          p.status === "handoff_preparing" ||
          p.status === "handing_off"
      ),
      `expected retryable failure persist, got ${JSON.stringify(persisted)}`
    );
    const lease = readLease(run.runId);
    assert.equal(lease?.released_at, null);
    assert.equal(lease?.attempt_id, a1.id);
  });
});

test("second request_handoff clears prior ready until new matching acknowledgement", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:r4",
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
    st.status = "handoff_preparing";
    st.supervision = { enabled: true };
    st.worker = { tmux: "sess", cli: "claude", model: "m1" };
    st.usage_used = 0.92;
    st.checkpoint = {
      schema: "team-up.checkpoint/v1",
      status: "complete",
      run_id: run.runId,
      attempt_id: a1.id,
      completed: ["old"],
      open: [],
      artifacts: [],
      verification_commands: [],
      risks: [],
      questions: [],
    };
    saveState(st);

    const mb = path.join(runDir(run.runId), "mailbox");
    fs.mkdirSync(mb, { recursive: true });
    fs.writeFileSync(
      path.join(mb, "CONTROL.json"),
      JSON.stringify({
        type: "handoff_ready",
        handoff_ready: true,
        at: "2026-07-25T17:00:00Z",
        handoff_epoch: "epoch-1",
      })
    );
    fs.writeFileSync(
      path.join(mb, "CHECKPOINT.json"),
      JSON.stringify(st.checkpoint)
    );

    const deps = buildProductionSuperviseDeps({
      now: "2026-07-25T18:00:00Z",
      injectControl: async () => {},
      stopTmux: async () => {},
      startWorker: async () => {},
      refreshUsageImpl: async () => ({ ok: true }),
    });

    await deps.writeControl({
      type: "request_handoff",
      at: "2026-07-25T18:00:00Z",
      runId: run.runId,
    });

    const control = JSON.parse(
      fs.readFileSync(path.join(mb, "CONTROL.json"), "utf8")
    );
    assert.equal(control.handoff_ready, false);
    assert.equal(control.type, "request_handoff");
    assert.ok(control.handoff_epoch);
    assert.notEqual(control.handoff_epoch, "epoch-1");

    const listed = listSupervisedRuns({
      now: "2026-07-25T18:00:01Z",
      processAliveOverride: () => true,
    });
    const row = listed.find((r) => r.runId === run.runId);
    assert.ok(row);
    assert.equal(row.handoffReady, false);
    assert.equal(
      decideTransition({
        state: "handoff_preparing",
        used: 0.92,
        prepareAt: 0.9,
        forceAt: 0.95,
        heartbeatFresh: true,
        processAlive: true,
        checkpoint: st.checkpoint,
        handoffReady: row.handoffReady,
      }).action,
      "observe"
    );

    // New matching ready for current epoch → may complete.
    fs.writeFileSync(
      path.join(mb, "CONTROL.json"),
      JSON.stringify({
        type: "handoff_ready",
        handoff_ready: true,
        at: "2026-07-25T18:01:00Z",
        handoff_epoch: control.handoff_epoch,
      })
    );
    const listed2 = listSupervisedRuns({
      now: "2026-07-25T18:01:01Z",
      processAliveOverride: () => true,
    });
    const row2 = listed2.find((r) => r.runId === run.runId);
    assert.equal(row2.handoffReady, true);
    assert.equal(
      decideTransition({
        state: row2.state === "handing_off" ? "handing_off" : "handoff_preparing",
        used: 0.92,
        prepareAt: 0.9,
        forceAt: 0.95,
        heartbeatFresh: true,
        processAlive: true,
        checkpoint: row2.checkpointForTransition || row2.checkpoint,
        handoffReady: row2.handoffReady,
      }).action,
      "complete_handoff"
    );
  });
});

test("due-wait resume retains startWorker tmux/sandbox/descriptor/runtime/windows", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:r4",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    persistLaunchDescriptor(run.runId, makeDescriptor(run.runId));
    const st = loadState(run.runId);
    st.status = "waiting_capacity";
    st.capacity = {
      auto_resume: true,
      wait_cancelled: false,
      next_reset_at: "2026-07-25T10:00:00Z",
    };
    st.worker = { tmux: "old-dead", cli: "claude", model: "m1" };
    st.sandbox = { mode: "none", enforced: false };
    st.runtime = { cli: "claude", model: "m1", limit_windows: ["claude:5h"] };
    saveState(st);

    const roster = JSON.parse(fs.readFileSync(process.env.TEAM_UP_ROSTER, "utf8"));
    await recheckCapacity({
      runId: run.runId,
      usage: { windows: {} },
      roster,
      profileResult: {
        chain: [{ cli: "claude", model: "m2", effort: null }],
      },
      now: "2026-07-25T18:00:00Z",
      startWorker: async ({ attempt, runId }) => {
        const live = loadState(runId);
        live.worker = {
          tmux: "new-live",
          cli: "claude",
          model: "m2",
          limit_windows: ["claude:7d"],
        };
        live.sandbox = {
          mode: "systemd-run",
          enforced: true,
          unit: "team-up-new.scope",
        };
        live.runtime = {
          cli: "claude",
          model: "m2",
          limit_windows: attempt.runtime.limit_windows,
        };
        persistLaunchDescriptor(runId, {
          ...loadAuthoritativeLaunchDescriptor(runId),
          model: "m2",
          limit_windows: attempt.runtime.limit_windows,
          sandbox: live.sandbox,
        });
        live.launch_descriptor = loadState(runId).launch_descriptor;
        saveState(live);
      },
    });

    const live = loadState(run.runId);
    assert.equal(live.worker?.tmux, "new-live");
    assert.equal(live.sandbox?.unit, "team-up-new.scope");
    assert.equal(live.sandbox?.enforced, true);
    assert.equal(live.runtime?.model, "m2");
    assert.deepEqual(live.runtime?.limit_windows, ["claude:7d"]);
    const auth = loadAuthoritativeLaunchDescriptor(run.runId);
    assert.equal(auth.model, "m2");
    assert.deepEqual(auth.limit_windows, ["claude:7d"]);
  });
});
