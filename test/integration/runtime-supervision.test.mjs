import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { installPackage } from "../../src/specialists/store.mjs";
import { approveSpecialist, isApproved } from "../../src/specialists/approvals.mjs";
import { resolveProfile } from "../../src/roster/profile.mjs";
import { commandPolicyChecksum } from "../../src/commands/policy.mjs";
import { normalizeBudget } from "../../src/specialists/budget.mjs";
import { decideTransition } from "../../src/supervisor/controller.mjs";
import {
  createAttempt,
  acquireAttemptLease,
  releaseAttemptLease,
} from "../../src/supervisor/attempts.mjs";
import { createRun, loadState, runDir } from "../../src/runs/runs.mjs";
import {
  approveCapacityWait,
  cancelCapacityWait,
  listDueWaits,
} from "../../src/supervisor/waits.mjs";
import { materializePartialCheckpoint, validateCheckpoint } from "../../src/supervisor/checkpoint.mjs";
import { findSpecialistRepos } from "../helpers/specialist-repos.mjs";

const REPOS = findSpecialistRepos(path.dirname(fileURLToPath(import.meta.url)));
const HANNES = path.join(REPOS, "team-up-with-hannes");
const brokerBin = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../bin/team-up-command-broker.mjs"
);

const policy = {
  schema_version: 1,
  commands: {
    "project-test": {
      argv: [process.execPath, "-e", "process.stdout.write('ok')"],
      cwd: ".",
      timeout_seconds: 30,
      environment: {},
    },
  },
};

test("runtime supervision fake-harness integration", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-rt-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-rt-proj-"));
  const env = {
    ...process.env,
    TEAM_UP_HOME: home,
    TEAM_UP_RUNS: path.join(home, "runs"),
    TEAM_UP_ROSTER: path.join(home, "roster.json"),
    TEAM_UP_USAGE: path.join(home, "usage.json"),
  };
  const prev = { ...process.env };
  Object.assign(process.env, env);
  try {
    fs.mkdirSync(path.join(project, ".team-up"), { recursive: true });
    fs.writeFileSync(path.join(project, ".team-up", "commands.json"), JSON.stringify(policy));

    const roster = {
      accounts: {
        claude: { kind: "subscription", enabled: true },
        cursor: { kind: "subscription", enabled: true },
      },
      clis: {
        claude: { cmd: ["claude", "--model", "{model}", "{prompt}"] },
        cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] },
      },
      models: {
        "frontier-claude": {
          tier: "frontier",
          cli: ["claude"],
          account: "claude",
          reasoning: { max: "max" },
          priority: 1,
          limit_windows: ["claude:5h"],
        },
        "frontier-cursor": {
          tier: "frontier",
          cli: ["cursor"],
          account: "cursor",
          reasoning: { max: "xhigh" },
          priority: 2,
        },
        "high-x": {
          tier: "high",
          cli: ["claude"],
          account: "claude",
          reasoning: { max: "max" },
          priority: 1,
        },
      },
    };
    fs.writeFileSync(env.TEAM_UP_ROSTER, JSON.stringify(roster));
    fs.writeFileSync(env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));

    const inst = await installPackage(HANNES, env);
    assert.equal(inst.ok, true, inst.errors?.join("; "));
    const ap = await approveSpecialist({
      idAtVersion: "testing.hannes@0.1.0",
      project,
      env,
    });
    assert.equal(ap.ok, true, ap.errors?.join("; "));
    const checksum = commandPolicyChecksum(policy);
    assert.equal(ap.approval.command_policy_checksum, checksum);
    assert.equal(
      isApproved({
        project,
        id: "testing.hannes",
        version: "0.1.0",
        checksum: inst.checksum,
        permissions: ap.approval.permissions,
        command_policy_checksum: "sha256:changed",
        env,
      }),
      false
    );

    const resolved = resolveProfile({
      roster,
      usage: {},
      profile: { tier: "frontier", reasoning: "max" },
      requirements: { command_broker: "team-up.command-broker/v1" },
      harnessCapabilities: (cli) =>
        cli === "claude"
          ? { command_broker: "team-up.command-broker/v1" }
          : { command_broker: null },
    });
    assert.deepEqual(resolved.chain.map((c) => c.cli), ["claude"]);
    assert.ok(!resolved.chain.some((c) => c.model === "high-x"));

    const budget = normalizeBudget({
      timeout_seconds: 1800,
      tokens: { target: 80000, enforcement: "advisory" },
    });
    assert.equal(budget.tokens.enforcement, "advisory");

    const runDirPath = fs.mkdtempSync(path.join(home, "broker-run-"));
    const { snapshotCommandPolicy } = await import("../../src/commands/policy.mjs");
    const snap = snapshotCommandPolicy({
      policy,
      runId: path.basename(runDirPath),
      workerVisibleDir: path.join(runDirPath, "policy"),
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [brokerBin],
      env: {
        ...process.env,
        TEAM_UP_HOME: home,
        TEAM_UP_COMMAND_POLICY_SNAPSHOT: snap.path,
        TEAM_UP_COMMAND_POLICY_CHECKSUM: snap.checksum,
        TEAM_UP_PROJECT: project,
        TEAM_UP_RUN_DIR: runDirPath,
      },
    });
    const client = new Client({ name: "rt-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((t) => t.name), ["project_test"]);
      const ok = await client.callTool({ name: "project_test", arguments: {} });
      assert.equal(JSON.parse(ok.content[0].text).stdout, "ok");
    } finally {
      await client.close();
    }

    assert.equal(
      decideTransition({
        state: "running",
        used: 0.9,
        prepareAt: 0.9,
        forceAt: 0.95,
        heartbeatFresh: true,
        processAlive: true,
        checkpoint: null,
      }).action,
      "request_handoff"
    );

    const run = createRun({
      cwd: project,
      project,
      role: "specialist:testing.hannes",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "frontier-claude" },
      prompt: "test",
      result_protocol: "RESULT.json",
    });
    const a1 = createAttempt({
      runId: run.runId,
      runtime: { cli: "claude", model: "frontier-claude" },
      specialist: { id: "testing.hannes", version: "0.1.0", checksum: inst.checksum },
    });
    assert.equal(acquireAttemptLease({ runId: run.runId, attemptId: a1.id, expectedPrevious: null }).ok, true);
    const cp = materializePartialCheckpoint({
      runId: run.runId,
      attemptId: a1.id,
    });
    assert.equal(validateCheckpoint(cp, { runId: run.runId, attemptId: a1.id }).ok, true);
    releaseAttemptLease({ runId: run.runId, attemptId: a1.id, reason: "handoff" });
    const a2 = createAttempt({
      runId: run.runId,
      runtime: { cli: "claude", model: "frontier-claude" },
      specialist: { id: "testing.hannes", version: "0.1.0", checksum: inst.checksum },
    });
    assert.equal(
      acquireAttemptLease({ runId: run.runId, attemptId: a2.id, expectedPrevious: a1.id }).ok,
      true
    );

    const { chainCapacityReport } = await import("../../src/supervisor/capacity.mjs");
    const capacity = chainCapacityReport({
      profileResult: {
        chain: [{ cli: "claude", model: "frontier-claude" }],
      },
      usage: {
        windows: {
          "claude:5h": {
            used: 0.99,
            resets_at: "2026-07-25T18:30:00.000Z",
            reset_confidence: "provider",
            updated_at: "2026-07-25T16:00:00Z",
          },
        },
      },
      roster: {
        ...roster,
        limits: { handoff_at: 0.95, handoff_at_burst: 0.9 },
      },
      now: "2026-07-25T16:00:00Z",
    });
    assert.equal(capacity.available_count, 0);
    assert.equal(capacity.next_reset_at, "2026-07-25T18:30:00.000Z");

    approveCapacityWait({
      runId: run.runId,
      nextResetAt: "2026-07-25T18:30:00Z",
      now: "2026-07-25T17:00:00Z",
    });
    assert.deepEqual(listDueWaits({ now: "2026-07-25T18:30:01Z" }), [run.runId]);
    cancelCapacityWait({ runId: run.runId, reason: "human requested" });
    assert.equal(loadState(run.runId).capacity.auto_resume, false);
    assert.equal(fs.existsSync(runDir(run.runId)), true);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
