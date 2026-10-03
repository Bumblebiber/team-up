import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, resolveRuntimeOverride, runSpecialist } from "../../src/specialists/launcher.mjs";
import { wrapWithSandbox } from "../../src/sandbox/systemd.mjs";
import { installPackage } from "../../src/specialists/store.mjs";
import { approveSpecialist } from "../../src/specialists/approvals.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";
import { resolveProfile } from "../../src/roster/profile.mjs";
import { createRun } from "../../src/runs/runs.mjs";
import { capsuleContextDir } from "../../src/capabilities/capsule.mjs";
import { loadAuthoritativeLaunchDescriptor } from "../../src/supervisor/start.mjs";

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
        cli: ["claude"],
        account: "anthropic",
        reasoning: { low: null },
        priority: 1,
      },
    },
    specialists: { "testing.capsule": { chain: ["claude:m"] } },
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
          cli: ["claude"],
          account: "anthropic",
          reasoning: { low: null },
          priority: 1,
        },
      },
    },
    usage: {},
    profile: { chain: ["claude:m"] },
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

/** Two more models beside the fixture's `m`, off the specialist's chain, for
 *  the override tests. */
function widenRoster(env) {
  const roster = JSON.parse(fs.readFileSync(env.TEAM_UP_ROSTER, "utf8"));
  // The fixture's `claude` is the home-installed one; the sandbox refuses it
  // without explicit runtime paths, and that refusal is not what is under test.
  roster.clis.claude.sandbox_runtime_paths = ["/usr/bin", "/bin"];
  roster.models.big = {
    cli: ["claude"], account: "anthropic", reasoning: { low: null }, priority: 1,
  };
  roster.accounts.broke = { kind: "subscription", enabled: false };
  roster.models.unreachable = {
    cli: ["claude"], account: "broke", reasoning: { low: null }, priority: 0,
  };
  fs.writeFileSync(env.TEAM_UP_ROSTER, JSON.stringify(roster));
}

test("resolveRuntimeOverride refuses what the roster does not have", () => {
  const roster = { clis: { claude: { cmd: ["claude"] } }, models: { m: { cli: ["claude"] } } };
  assert.equal(resolveRuntimeOverride(roster, null), null);
  assert.equal(resolveRuntimeOverride(roster, {}), null);
  assert.deepEqual(resolveRuntimeOverride(roster, { model: "m" }), {
    cli: null, model: "m",
  });
  assert.throws(() => resolveRuntimeOverride(roster, { model: "nope" }), /unknown model/);
  assert.throws(() => resolveRuntimeOverride(roster, { cli: "nope" }), /unknown cli/);
});

test("a one-off model override replaces the specialist's chain with that one cell", async () => {
  const fixture = await fixtureLaunch();
  widenRoster(fixture.env);
  const storedProfile = (result) => JSON.parse(fs.readFileSync(
    path.join(fixture.env.TEAM_UP_RUNS, result.runId, "STATE.json"), "utf8",
  )).specialist_profile;
  try {
    const plain = await launch({ ...fixture.args, dependencyOverrides: ISOLATED });
    assert.equal(plain.runtime.model, "m");
    assert.deepEqual(storedProfile(plain), { chain: ["claude:m"] });
    const overridden = await launch({
      ...fixture.args, runtime: { model: "big" }, dependencyOverrides: ISOLATED,
    });
    assert.equal(overridden.runtime.model, "big");
    assert.equal(overridden.runtime.cli, "claude");
    // A capacity wait re-resolves the cell the caller asked for, not the chain.
    assert.deepEqual(storedProfile(overridden), { chain: [{ model: "big", cli: "claude" }] });
  } finally {
    restoreEnv(fixture.prev, [fixture.home, fixture.project, fixture.pkg]);
  }
});

test("the worker cwd is capsuleContextDir, the function the isolation canary probes from", async () => {
  const fixture = await fixtureLaunch();
  widenRoster(fixture.env);
  let seen = null;
  try {
    const result = await launch({
      ...fixture.args,
      dependencyOverrides: {
        ...ISOLATED,
        prepareHarnessLaunch: ({ argv, runDir, capsule }) => {
          seen = { runDir, capsule };
          return { argv, env: {}, files: [] };
        },
      },
    });
    // Claude reads project config from every directory above its cwd, so a
    // leak depends on where the cwd sits. The canary only measures production
    // if both derive the cwd the same way.
    const cwd = capsuleContextDir(seen.runDir);
    assert.equal(seen.capsule.contextDir, cwd);
    assert.equal(loadAuthoritativeLaunchDescriptor(result.runId).context_dir, cwd);
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
      dryRun: false,
      dependencyOverrides: {
        startFromLaunchDescriptor: () => {},
        prepareHarnessLaunch: ({ argv }) => ({ argv, env: {}, files: [] }),
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

test("a dry run previews the refusal instead of paying for a verification", async () => {
  const fixture = await fixtureLaunch();
  widenRoster(fixture.env);
  try {
    const calls = [];
    await assert.rejects(
      () => launch({
        ...fixture.args,
        dependencyOverrides: {
          harnessCapabilities: () => ({
            command_broker: null,
            context_isolation: null,
            native_shell: "denied",
            mcp: "stdio",
          }),
          reverifyDrifted: async (cli) => {
            calls.push(cli);
            return { cli, attempted: true, status: "verified" };
          },
        },
      }),
      /PROFILE_UNAVAILABLE/,
    );
    assert.deepEqual(calls, []);
  } finally {
    restoreEnv(fixture.prev, [fixture.home, fixture.project, fixture.pkg]);
  }
});

test("an auto_invoke package opens the worker prompt with its skill", async () => {
  const fixture = await fixtureLaunch();
  widenRoster(fixture.env);
  const capPkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-launch-cap-"));
  fs.mkdirSync(path.join(capPkg, "skills", "caveman"), { recursive: true });
  fs.writeFileSync(path.join(capPkg, "skills", "caveman", "SKILL.md"), "# Caveman\n");
  fs.writeFileSync(path.join(capPkg, "capability.json"), JSON.stringify({
    schema_version: 1, id: "style.caveman", version: "1", display_name: "C",
    auto_invoke: ["caveman"],
    provides: { skills: ["skills/caveman/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }));
  try {
    const result = await launch({
      ...fixture.args,
      dependencyOverrides: {
        ...ISOLATED,
        resolveEffectiveCapabilities: () => ({
          packages: [{
            package: "style.caveman@1", id: "style.caveman", version: "1",
            checksum: "sha256:a", packageDir: capPkg, reason: "target:all",
          }],
          exclusions: [],
        }),
      },
    });
    const runPath = path.join(fixture.env.TEAM_UP_RUNS, result.runId);
    const prompt = fs.readFileSync(path.join(runPath, "mailbox", "PROMPT.md"), "utf8");
    assert.match(prompt, /^\/caveman\n\n# Worker task/);
    const state = JSON.parse(fs.readFileSync(path.join(runPath, "STATE.json"), "utf8"));
    assert.deepEqual(state.auto_invoke, { skills: ["caveman"], applied: true });
  } finally {
    restoreEnv(fixture.prev, [fixture.home, fixture.project, fixture.pkg, capPkg]);
  }
});

test("admission: a refusal creates nothing, --wait-capacity parks the run, --force-admission is recorded", async () => {
  const fixture = await fixtureLaunch();
  widenRoster(fixture.env);
  const base = {
    ...ISOLATED,
    startFromLaunchDescriptor: () => {},
    prepareHarnessLaunch: ({ argv }) => ({ argv, env: {}, files: [] }),
    memoryCeiling: () => null,
  };
  const refused = async () => ({ ok: false, reason: "MemAvailable 900 MB - 1200 MB for the worker < reserve 1024 MB" });
  try {
    const created = [];
    await assert.rejects(() => launch({
      ...fixture.args,
      dryRun: false,
      dependencyOverrides: { ...base, checkAdmission: refused, createRun: (a) => { created.push(a); return createRun(a); } },
    }), (e) => e.code === "ADMISSION_REFUSED" && /reserve 1024 MB/.test(e.message));
    assert.equal(created.length, 0);

    const parkedArgs = [];
    let started = false;
    const parked = await launch({
      ...fixture.args,
      dryRun: false,
      admission: "wait",
      dependencyOverrides: {
        ...base,
        checkAdmission: refused,
        startFromLaunchDescriptor: () => { started = true; },
        deferForResources: (args) => parkedArgs.push(args),
      },
    });
    assert.equal(started, false);
    assert.match(parked.waiting_capacity, /reserve 1024 MB/);
    assert.equal(parkedArgs.length, 1);
    assert.equal(parkedArgs[0].runId, parked.runId);

    let checked = false;
    const forced = await launch({
      ...fixture.args,
      dryRun: false,
      admission: "force",
      dependencyOverrides: { ...base, checkAdmission: async () => { checked = true; return { ok: false, reason: "x" }; } },
    });
    assert.equal(checked, false);
    assert.equal(forced.admission_forced, true);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.env.TEAM_UP_RUNS, forced.runId, "STATE.json"), "utf8"));
    assert.equal(state.admission.forced, true);
  } finally {
    restoreEnv(fixture.prev, [fixture.home, fixture.project, fixture.pkg]);
  }
});

test("specialist run maps ADMISSION_REFUSED to exit 3 and passes the admission flags", async () => {
  const seen = [];
  const io = { out: () => {}, err: (line) => seen.push(line) };
  const refuse = async (args) => {
    seen.push(args.admission);
    throw Object.assign(new Error("ADMISSION_REFUSED: 3 workers running, limit 3"), { code: "ADMISSION_REFUSED" });
  };
  const base = ["--id", "x", "--objective", "o"];
  assert.equal((await runSpecialist(base, io, { launchFn: refuse })).code, 3);
  await runSpecialist([...base, "--wait-capacity"], io, { launchFn: refuse });
  await runSpecialist([...base, "--force-admission"], io, { launchFn: refuse });
  assert.deepEqual(seen.filter((s) => !String(s).startsWith("ADMISSION")), ["check", "wait", "force"]);
  assert.ok(seen.some((s) => /ADMISSION_REFUSED: 3 workers running/.test(s)));
});
