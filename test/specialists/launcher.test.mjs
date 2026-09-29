import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, resolveRuntimeOverride } from "../../src/specialists/launcher.mjs";
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
        permissions: { writes: false },
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

/** The fixture home has no harness verification records, so isolation is
 *  asserted here the same way the capsule test does. */
const ISOLATED = {
  harnessCapabilities: () => ({
    command_broker: null,
    context_isolation: CONTEXT_ISOLATION_CAPABILITY,
    native_shell: "denied",
    mcp: "stdio",
  }),
};

/** Two more cells beside the fixture's medium `m`, for the override tests. */
function widenRoster(env) {
  const roster = JSON.parse(fs.readFileSync(env.TEAM_UP_ROSTER, "utf8"));
  // The fixture's `claude` is the home-installed one; the sandbox refuses it
  // without explicit runtime paths, and that refusal is not what is under test.
  roster.clis.claude.sandbox_runtime_paths = ["/usr/bin", "/bin"];
  roster.models.big = {
    tier: "frontier", cli: ["claude"], account: "anthropic", reasoning: { low: null }, priority: 1,
  };
  roster.accounts.broke = { kind: "subscription", enabled: false };
  roster.models.unreachable = {
    tier: "frontier", cli: ["claude"], account: "broke", reasoning: { low: null }, priority: 0,
  };
  fs.writeFileSync(env.TEAM_UP_ROSTER, JSON.stringify(roster));
}

test("resolveRuntimeOverride refuses what the roster does not have", () => {
  const roster = { clis: { claude: { cmd: ["claude"] } }, models: { m: { tier: "medium" } } };
  assert.equal(resolveRuntimeOverride(roster, null), null);
  assert.equal(resolveRuntimeOverride(roster, {}), null);
  assert.deepEqual(resolveRuntimeOverride(roster, { model: "m" }), {
    cli: null, model: "m", profile: { tier: "medium" },
  });
  assert.throws(() => resolveRuntimeOverride(roster, { model: "nope" }), /unknown model/);
  assert.throws(() => resolveRuntimeOverride(roster, { cli: "nope" }), /unknown cli/);
});

test("a one-off model override crosses the tier the specialist asked for", async () => {
  const fixture = await fixtureLaunch();
  widenRoster(fixture.env);
  try {
    const plain = await launch({ ...fixture.args, dependencyOverrides: ISOLATED });
    assert.equal(plain.runtime.model, "m");
    const overridden = await launch({
      ...fixture.args, runtime: { model: "big" }, dependencyOverrides: ISOLATED,
    });
    assert.equal(overridden.runtime.model, "big");
    assert.equal(overridden.runtime.cli, "claude");
  } finally {
    restoreEnv(fixture.prev, [fixture.home, fixture.project, fixture.pkg]);
  }
});

test("an override still has to pass the gates, and is refused rather than swapped", async () => {
  const fixture = await fixtureLaunch();
  widenRoster(fixture.env);
  try {
    await assert.rejects(
      () => launch({
        ...fixture.args, runtime: { model: "unreachable" }, dependencyOverrides: ISOLATED,
      }),
      /RUNTIME_OVERRIDE_UNAVAILABLE: unreachable/,
    );
  } finally {
    restoreEnv(fixture.prev, [fixture.home, fixture.project, fixture.pkg]);
  }
});

/**
 * A CLI self-update revokes every grant it proved, and the first launch after
 * one used to fail with PROFILE_UNAVAILABLE naming the roster. It now pays for
 * one re-verification instead — but only when a capability was what got
 * skipped, never for an exhausted quota window.
 */
test("a launch re-verifies drift once instead of refusing", async () => {
  const fixture = await fixtureLaunch();
  widenRoster(fixture.env);
  try {
    let verified = false;
    const calls = [];
    const result = await launch({
      ...fixture.args,
      dependencyOverrides: {
        harnessCapabilities: () => ({
          command_broker: null,
          context_isolation: verified ? CONTEXT_ISOLATION_CAPABILITY : null,
          native_shell: "denied",
          mcp: "stdio",
        }),
        reverifyDrifted: async (cli) => {
          calls.push(cli);
          verified = true;
          return { cli, attempted: true, status: "verified" };
        },
      },
    });
    assert.deepEqual(calls, ["claude"]);
    assert.equal(result.runtime.model, "m");
  } finally {
    restoreEnv(fixture.prev, [fixture.home, fixture.project, fixture.pkg]);
  }
});

test("a cell skipped for anything but a capability buys no verification", async () => {
  const fixture = await fixtureLaunch();
  widenRoster(fixture.env);
  try {
    const calls = [];
    await assert.rejects(
      () => launch({
        ...fixture.args,
        runtime: { model: "unreachable" },
        dependencyOverrides: {
          ...ISOLATED,
          reverifyDrifted: async (cli) => {
            calls.push(cli);
            return { cli, attempted: false, status: "verified" };
          },
        },
      }),
      /RUNTIME_OVERRIDE_UNAVAILABLE/,
    );
    assert.deepEqual(calls, []);
  } finally {
    restoreEnv(fixture.prev, [fixture.home, fixture.project, fixture.pkg]);
  }
});
