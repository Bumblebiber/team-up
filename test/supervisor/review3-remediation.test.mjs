import "../helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, loadState, saveState, runDir } from "../../src/runs/runs.mjs";
import {
  createAttempt,
  acquireAttemptLease,
  releaseAttemptLease,
} from "../../src/supervisor/attempts.mjs";
import {
  buildLaunchDescriptor,
  persistLaunchDescriptor,
  loadAuthoritativeLaunchDescriptor,
  prepareArgvFromDescriptor,
  startFromLaunchDescriptor,
  LAUNCH_REF_SCHEMA,
} from "../../src/supervisor/start.mjs";
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

test("a start with a runtime override records the new cell in STATE.picks", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:r3",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    persistLaunchDescriptor(run.runId, makeDescriptor(run.runId));
    startFromLaunchDescriptor({
      runId: run.runId,
      runtimeOverride: { cli: "claude", model: "m2" },
      startTmux: () => {},
    });
    const state = loadState(run.runId);
    assert.equal(state.status, "watching");
    assert.equal(state.picks?.length, 1);
    assert.equal(state.picks[0].cli, "claude");
    assert.equal(state.picks[0].model, "m2");
    assert.equal(state.picks[0].pinned, false);
    assert.equal(state.picks[0].skipped, null);
  });
});

test("a start without a runtime override records no pick (the launcher records its own)", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:r3",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    persistLaunchDescriptor(run.runId, makeDescriptor(run.runId));
    startFromLaunchDescriptor({ runId: run.runId, startTmux: () => {} });
    const state = loadState(run.runId);
    assert.equal(state.status, "watching");
    assert.equal(state.picks, undefined);
  });
});
