import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "../../src/specialists/launcher.mjs";
import { wrapWithSandbox } from "../../src/sandbox/systemd.mjs";
import { installPackage } from "../../src/specialists/store.mjs";
import { approveSpecialist } from "../../src/specialists/approvals.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";
import { resolveProfile } from "../../src/roster/profile.mjs";
import { createRun } from "../../src/runs/runs.mjs";

test("launcher refuses required sandbox when probe fails; missing specialist still errors", async () => {
  await assert.rejects(
    async () => {
      wrapWithSandbox({
        command: ["true"],
        permissions: { network: false },
        cwd: "/tmp",
        probe: () => false,
        enforcement: "required",
      });
    },
    /SANDBOX_UNAVAILABLE/
  );
  await assert.rejects(
    () =>
      launch({
        specialistId: "missing",
        callType: "review",
        objective: "x",
        project: "/tmp",
        sandbox: { probe: () => false },
        permissions: { network: false },
      }),
    /not installed/
  );
});

function writePkg(dir, manifest) {
  fs.writeFileSync(path.join(dir, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evals", "evals.json"), "[]");
}

async function fixtureLaunch(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-launch-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-launch-proj-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-launch-pkg-"));
  const env = {
    ...process.env,
    TEAM_UP_HOME: home,
    TEAM_UP_RUNS: path.join(home, "runs"),
    TEAM_UP_ROSTER: path.join(home, "roster.json"),
    TEAM_UP_USAGE: path.join(home, "usage.json"),
  };
  fs.writeFileSync(env.TEAM_UP_ROSTER, JSON.stringify({
    accounts: { anthropic: { kind: "subscription", enabled: true } },
    clis: { claude: { cmd: ["claude", "{prompt}"] } },
    models: {
      m: {
        tier: "medium",
        cli: ["claude"],
        account: "anthropic",
        reasoning: { low: null },
        priority: 1,
      },
    },
  }));
  fs.writeFileSync(env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));
  writePkg(pkg, {
    schema_version: 1,
    id: "testing.capsule",
    display_name: "Capsule",
    version: "0.1.0",
    remit: ["x"],
    anti_remit: ["y"],
    call_types: ["consult", "delegate", "review"],
    accepted_inputs: ["task_description"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
    permissions: { filesystem: "project_readonly", writes: false, network: false, commands: [] },
    budget: { timeout_seconds: 60, max_tokens: 1000 },
    model_profile: { tier: "medium", reasoning: "low" },
    eval_suite: "evals/evals.json",
  });
  assert.equal((await installPackage(pkg, env)).ok, true);
  assert.equal((await approveSpecialist({
    idAtVersion: "testing.capsule@0.1.0", project, env,
  })).ok, true);
  const prev = { ...process.env };
  Object.assign(process.env, env);
  return {
    home, project, pkg, env, prev,
    args: {
      specialistId: "testing.capsule",
      callType: "consult",
      objective: "capsule check",
      project,
      env,
      dryRun: true,
      sandbox: { available: true, probe: () => true },
      ...overrides,
    },
  };
}

function restoreEnv(prev, paths) {
  for (const k of Object.keys(process.env)) {
    if (!(k in prev)) delete process.env[k];
  }
  Object.assign(process.env, prev);
  for (const p of paths) fs.rmSync(p, { recursive: true, force: true });
}

test("capsule failure prevents worker creation and requires isolation", async () => {
  const fixture = await fixtureLaunch();
  const events = [];
  try {
    await assert.rejects(() => launch({
      ...fixture.args,
      dependencyOverrides: {
        harnessCapabilities: () => ({
          command_broker: null,
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
          native_shell: "denied",
          mcp: "stdio",
        }),
        resolveEffectiveCapabilities: () => {
          events.push("resolve");
          return { packages: [], exclusions: [] };
        },
        materializeCapabilityCapsule: () => {
          events.push("capsule");
          throw Object.assign(new Error("broken capsule"), {
            code: "CAPSULE_BUILD_FAILED",
          });
        },
        createRun: (args) => {
          events.push("run-record");
          return createRun(args);
        },
        startFromLaunchDescriptor: () => events.push("worker"),
        prepareHarnessLaunch: ({ argv }) => ({ argv, env: {}, files: [] }),
      },
    }), /broken capsule/);
    assert.deepEqual(events, ["resolve", "run-record", "capsule"]);
    assert.equal(events.includes("worker"), false);  } finally {
    restoreEnv(fixture.prev, [fixture.home, fixture.project, fixture.pkg]);
  }
});

test("profile skips harness verified for broker but not isolation", () => {
  const result = resolveProfile({
    roster: {
      accounts: { anthropic: { kind: "subscription", enabled: true } },
      clis: { claude: { cmd: ["claude", "{prompt}"] } },
      models: {
        m: {
          tier: "medium",
          cli: ["claude"],
          account: "anthropic",
          reasoning: { low: null },
          priority: 1,
        },
      },
    },
    usage: {},
    profile: { tier: "medium", reasoning: "low" },
    requirements: {
      context_isolation: CONTEXT_ISOLATION_CAPABILITY,
      command_broker: "team-up.command-broker/v1",
    },
    harnessCapabilities: () => ({
      command_broker: "team-up.command-broker/v1",
      context_isolation: null,
    }),
  });
  assert.equal(result.code, "PROFILE_UNAVAILABLE");
  assert.equal(result.chain.length, 0);
  assert.ok(result.skipped.some((x) => /context isolation/.test(x.reason)));
});
