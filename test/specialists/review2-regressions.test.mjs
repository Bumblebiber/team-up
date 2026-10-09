import "../helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateManifest, sha256Declared, declaredPackageFiles, loadManifestFromDir } from "../../src/specialists/manifest.mjs";
import { installPackage } from "../../src/specialists/store.mjs";
import { trustProjectPolicy } from "../../src/specialists/approvals.mjs";
import { launch } from "../../src/specialists/launcher.mjs";
import { materialize } from "../../src/sandbox/materialize.mjs";
import { createRun, classifyMailbox, setStatus, runDir, wrapPromptWithMailboxProtocol, loadState } from "../../src/runs/runs.mjs";
import { atomicWriteText } from "../../src/json-store.mjs";
import { resolveProfile } from "../../src/roster/profile.mjs";
import { buildCommand } from "../../src/roster/command.mjs";

function validManifest(overrides = {}) {
  return {
    schema_version: 1,
    id: "testing.reg",
    display_name: "Reg",
    version: "0.1.0",
    remit: ["x"],
    anti_remit: ["y"],
    call_types: ["consult", "delegate", "review"],
    accepted_inputs: ["task_description", "artifact_reference"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
    permissions: { filesystem: "project_readonly", writes: false, network: false, commands: [] },
    budget: { timeout_seconds: 60 },
    model_profile: { tier: "medium", reasoning: "low" },
    eval_suite: "evals/evals.json",
    ...overrides,
  };
}

function writePkg(dir, manifest, { skillBody = "skill\n" } = {}) {
  fs.writeFileSync(path.join(dir, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evals", "evals.json"), "[]");
  for (const skill of manifest.capabilities?.skills || []) {
    if (skill.includes("/") || skill.includes("..") || path.isAbsolute(skill)) continue;
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", `${skill}.md`), skillBody);
  }
}

function writeProjectCommands(project, actions = ["project-test"]) {
  const commands = {};
  for (const id of actions) {
    commands[id] = {
      argv: ["npm", "test"],
      cwd: ".",
      timeout_seconds: 1800,
      environment: {},
    };
  }
  const dir = path.join(project, ".team-up");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "commands.json"),
    JSON.stringify({ schema_version: 1, commands })
  );
}

function withTempRuns(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-runs-"));
    const prev = process.env.TEAM_UP_RUNS;
    process.env.TEAM_UP_RUNS = dir;
    try { await fn(dir); }
    finally {
      if (prev === undefined) delete process.env.TEAM_UP_RUNS;
      else process.env.TEAM_UP_RUNS = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// --- 1. malicious skill / eval paths ---

test("rejects malicious skill id ../../escape and absolute eval paths", () => {
  const badSkill = validManifest({
    capabilities: { skills: ["../../escape"], tools: [], mcps: [], frameworks: [] },
  });
  assert.equal(validateManifest(badSkill).ok, false);
  assert.match(validateManifest(badSkill).errors.join("\n"), /skill|unsafe|invalid|escape/i);

  const absEval = validManifest({ eval_suite: "/etc/passwd" });
  assert.equal(validateManifest(absEval).ok, false);
  assert.match(validateManifest(absEval).errors.join("\n"), /eval|unsafe|absolute/i);

  const traversalEval = validManifest({ eval_suite: "evals/../../escape.json" });
  assert.equal(validateManifest(traversalEval).ok, false);
});

test("install rejects malicious skill path segments", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-sk-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-pkg-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  writePkg(pkg, validManifest({
    id: "testing.evilskill",
    capabilities: { skills: ["../../escape"], tools: [], mcps: [], frameworks: [] },
  }));
  const r = await installPackage(pkg, env);
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /skill|unsafe|invalid|escape/i);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(pkg, { recursive: true, force: true });
});

// --- 2. package integrity after mutation ---

test("tampered installed file fails PACKAGE_INTEGRITY_FAILED and does not launch", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-int-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-proj-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-ipkg-"));
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
    writePkg(pkg, validManifest({ id: "testing.integrity" }));
    const inst = await installPackage(pkg, env);
    assert.equal(inst.ok, true, inst.errors?.join("; "));
    // Mutate installed instructions after install.
    fs.writeFileSync(path.join(inst.path, "instructions.md"), "MUTATED\n");

    await assert.rejects(
      () => launch({
        specialistId: "testing.integrity",
        callType: "consult",
        objective: "should fail integrity",
        project,
        env,
        dryRun: true,
      }),
      (e) => e.code === "PACKAGE_INTEGRITY_FAILED" || /PACKAGE_INTEGRITY_FAILED/.test(e.message)
    );
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});

// --- 3. unmediated command/tool policy ---

test("non-empty commands without declared command broker → PROFILE_UNAVAILABLE", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-allow-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-ap-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-apk-"));
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
    fs.writeFileSync(env.TEAM_UP_ROSTER, JSON.stringify({
      accounts: { cursor: { kind: "subscription", enabled: true } },
      clis: {
        cursor: {
          cmd: ["true", "{prompt}"],
          // no mediated_commands
        },
      },
      models: {
        m: {
          cli: ["cursor"],
          account: "cursor",
          reasoning: { low: null },
          priority: 1,
        },
      },
      specialists: { "testing.cmds": { chain: ["cursor:m"] } },
    }));
    fs.writeFileSync(env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));
    writePkg(pkg, validManifest({
      id: "testing.cmds",
      permissions: {
        filesystem: "project_readonly",
        writes: false,
        network: false,
        commands: ["project-test"],
      },
    }));
    writeProjectCommands(project);
    const inst = await installPackage(pkg, env);
    assert.equal(inst.ok, true, inst.errors?.join("; "));
    assert.equal(trustProjectPolicy({ project, env }).ok, true);

    await assert.rejects(
      () => launch({
        specialistId: "testing.cmds",
        callType: "consult",
        objective: "run tests",
        project,
        env,
        dryRun: true,
      }),
      (e) => e.code === "PROFILE_UNAVAILABLE" || /PROFILE_UNAVAILABLE|command broker/.test(e.message)
    );
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});

// --- 4. generic vs typed mailbox ---

test("generic run + RESULT.md → done", withTempRuns(async () => {
  const s = createRun({
    cwd: "/tmp/p",
    role: "implementer",
    parent: { cli: "codex", attach: "manual" },
    worker: { cli: "cursor" },
    prompt: "generic work",
    // no result_protocol → legacy RESULT.md
  });
  assert.notEqual(loadState(s.runId)?.result_protocol, "RESULT.json");
  const mb = path.join(runDir(s.runId), "mailbox");
  atomicWriteText(path.join(mb, "RESULT.md"), "# done\n");
  setStatus(s.runId, "done");
  const c = classifyMailbox(s.runId);
  assert.equal(c.status, "done");
}));

test("specialist typed run + only RESULT.md → failed", withTempRuns(async () => {
  const s = createRun({
    cwd: "/tmp/p",
    role: "specialist:x",
    parent: { cli: "team-up", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "typed",
    result_protocol: "RESULT.json",
  });
  assert.equal(loadState(s.runId).result_protocol, "RESULT.json");
  const mb = path.join(runDir(s.runId), "mailbox");
  atomicWriteText(path.join(mb, "RESULT.md"), "# not enough\n");
  setStatus(s.runId, "done");
  const c = classifyMailbox(s.runId);
  assert.equal(c.status, "failed");
  assert.match(c.error, /RESULT\.json/);
}));

test("specialist typed run + valid RESULT.json → done", withTempRuns(async () => {
  const s = createRun({
    cwd: "/tmp/p",
    role: "specialist:x",
    parent: { cli: "team-up", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "typed",
    result_protocol: "RESULT.json",
  });
  const mb = path.join(runDir(s.runId), "mailbox");
  fs.writeFileSync(path.join(mb, "RESULT.json"), JSON.stringify({
    schema: "team-up.result/v1",
    status: "success",
    summary: "ok",
  }));
  setStatus(s.runId, "done");
  assert.equal(classifyMailbox(s.runId).status, "done");
}));

test("already-wrapped legacy prompt stays compatible", () => {
  const legacy = [
    "# Worker task (mailbox protocol)",
    "",
    "Run directory: `/tmp/run`",
    "Mailbox: `/tmp/run/mailbox/`",
    "",
    "Write mailbox/STATUS = done and mailbox/RESULT.md when finished.",
    "Update HEARTBEAT often.",
    "",
    "## Task",
    "do the thing",
    "",
  ].join("\n");
  const out = wrapPromptWithMailboxProtocol(legacy, {
    runId: "r1",
    runDirectory: "/tmp/run",
  });
  assert.equal(out, legacy.endsWith("\n") ? legacy : `${legacy}\n`);
  assert.ok(!out.includes("team-up.result/v1") || legacy.includes("RESULT.md"));
});

// --- 6. filesystem:none ---

test("filesystem:none does not materialize from project root", async () => {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-fn-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-fnp-"));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-fnd-"));
  fs.writeFileSync(path.join(pkg, "specialist.json"), "{}");
  fs.writeFileSync(path.join(pkg, "instructions.md"), "x");
  fs.writeFileSync(path.join(project, "secret.txt"), "SECRET");
  await materialize({
    packageDir: pkg,
    request: { schema: "team-up.request/v1" },
    destination: dest,
    manifest: { capabilities: { skills: [] }, permissions: { filesystem: "none" } },
    projectRoot: project,
    inputs: [],
    filesystem: "none",
  });
  assert.equal(fs.existsSync(path.join(dest, "secret.txt")), false);
  assert.equal(fs.existsSync(path.join(dest, "inputs", "secret.txt")), false);
  fs.rmSync(pkg, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
});

// --- 7. token budget advisory ---

test("max_tokens is advisory and does not block launch", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-tok-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-tp-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-tk-"));
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
    fs.writeFileSync(env.TEAM_UP_ROSTER, JSON.stringify({
      accounts: { cursor: { kind: "subscription", enabled: true } },
      clis: {
        cursor: { cmd: ["true", "{prompt}"] },
      },
      models: {
        m: {
          cli: ["cursor"],
          account: "cursor",
          reasoning: { low: null },
          priority: 1,
        },
      },
      specialists: { "testing.tokens": { chain: ["cursor:m"] } },
    }));
    fs.writeFileSync(env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));
    writePkg(pkg, validManifest({
      id: "testing.tokens",
      budget: { timeout_seconds: 60, max_tokens: 80000 },
    }));
    assert.equal((await installPackage(pkg, env)).ok, true);

    const result = await launch({
      specialistId: "testing.tokens",
      callType: "consult",
      objective: "budget check",
      project,
      env,
      dryRun: true,
      dependencyOverrides: {
        harnessCapabilities: () => ({
          command_broker: null,
          context_isolation: "team-up.context-isolation/v1",
          native_shell: "unverified",
          mcp: "unverified",
        }),
        prepareHarnessLaunch: ({ argv }) => ({ argv, env: {}, files: [] }),
      },
    });
    assert.equal(result.budget.tokens.target, 80000);
    assert.equal(result.budget.tokens.enforcement, "advisory");
    assert.match(result.budget.warnings[0], /max_tokens.*advisory/);
    const state = loadState(result.runId);
    assert.equal(state.budget.tokens.enforcement, "advisory");
    assert.equal(state.status, "cancelled");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});

// --- reviewed pushback: a cell with no effort anywhere runs without one ---

test("a cell with no effort anywhere runs without the flag; the nearest effort wins", () => {
  const roster = {
    accounts: { cursor: { kind: "subscription", enabled: true } },
    clis: { cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] } },
    models: { m: { cli: ["cursor"], account: "cursor", priority: 1 } },
    roles: { r: { chain: ["cursor:m"] } },
    specialists: { x: { chain: ["cursor:m"] } },
  };
  const ok = resolveProfile({ roster, specialistId: "x", usage: {} });
  assert.equal(ok.code, "OK");
  assert.equal(ok.chain[0].effort, null);
  // buildCommand drops effort flag when null
  const argv = buildCommand({
    roster: {
      clis: {
        cursor: { cmd: ["cursor-agent", "-c", "effort={effort}", "--model", "{model}", "{prompt}"] },
      },
    },
    model: "m",
    cli: "cursor",
    prompt: "p",
    effort: null,
  });
  assert.deepEqual(argv, ["cursor-agent", "--model", "m", "p"]);

  // chain entry effort > role effort > the model's default effort.
  const effortOf = (patch, profile) => resolveProfile({
    roster: {
      ...roster,
      models: { m: { ...roster.models.m, ...patch.model } },
      roles: { r: { ...roster.roles.r, ...patch.role } },
    },
    profile,
    usage: {},
  }).chain[0].effort;
  assert.equal(effortOf({ model: { effort: "medium" } }, { chain: ["cursor:m"] }), "medium");
  assert.equal(effortOf({ model: { effort: "medium" }, role: { effort: "high" } }, { role: "r" }), "high");
  assert.equal(effortOf(
    { model: { effort: "medium" }, role: { effort: "high" } },
    { chain: [{ model: "m", cli: "cursor", effort: "low" }] },
  ), "low");
});

test("a project without a command policy launches on Claude without its commands", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-nopol-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-np-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r2-npk-"));
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
    // The same broker-less roster that refuses a launch needing commands.
    fs.writeFileSync(env.TEAM_UP_ROSTER, JSON.stringify({
      accounts: { anthropic: { kind: "subscription", enabled: true } },
      clis: { claude: { cmd: ["claude", "--dangerously-skip-permissions", "{prompt}"] } },
      models: { m: { cli: ["claude"], account: "anthropic", reasoning: { low: null }, priority: 1 } },
      specialists: { "testing.nopol": { chain: ["claude:m"] } },
    }));
    fs.writeFileSync(env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));
    writePkg(pkg, validManifest({
      id: "testing.nopol",
      permissions: { filesystem: "project_readonly", writes: false, network: false, commands: ["project-test"] },
    }));
    assert.equal((await installPackage(pkg, env)).ok, true);
    const args = {
      specialistId: "testing.nopol",
      callType: "consult",
      objective: "read the docs",
      project,
      env,
      dryRun: true,
      dependencyOverrides: {
        checkAdmission: async () => ({ ok: true }),
        harnessStatus: () => ({ cli: "claude", installed_version: "2.1.300", status: "verified" }),
      },
    };
    const result = await launch(args);
    assert.deepEqual(result.permissions.commands, []);
    assert.equal(loadState(result.runId).status, "cancelled");

    // A present policy needs its own trust action.
    writeProjectCommands(project);
    await assert.rejects(() => launch(args), (e) => e.code === "COMMAND_POLICY_UNTRUSTED");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});
