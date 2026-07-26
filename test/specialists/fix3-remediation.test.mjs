import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackage, pinSpecialist } from "../../src/specialists/store.mjs";
import { approveSpecialist, isApproved } from "../../src/specialists/approvals.mjs";
import { launch, cliSandboxConfig } from "../../src/specialists/launcher.mjs";
import { resolveCommandMediation } from "../../src/specialists/adapters.mjs";
import { normalizeBudget } from "../../src/specialists/budget.mjs";
import { loadState } from "../../src/runs/runs.mjs";
function validManifest(overrides = {}) {
  return {
    schema_version: 1,
    id: "testing.fix3",
    display_name: "Fix3",
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

function writePkg(dir, manifest) {
  fs.writeFileSync(path.join(dir, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evals", "evals.json"), "[]");
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

test("legacy mediated_commands:true cannot enable mediation (no concrete adapter)", () => {
  const r = resolveCommandMediation({ mediated_commands: true }, { mediated_commands: true });
  assert.equal(r.enabled, false);
  const cfg = cliSandboxConfig(
    { clis: { cursor: { sandbox: { mediated_commands: true } } } },
    "cursor"
  );
  assert.equal(cfg.mediated_commands, false);
});

test("legacy token_budget_adapter boolean is ignored; tokens stay advisory", () => {
  const normalized = normalizeBudget({ timeout_seconds: 60, max_tokens: 80000 });
  assert.equal(normalized.tokens.enforcement, "advisory");
  const cfg = cliSandboxConfig(
    { clis: { cursor: { sandbox: { token_budget_adapter: true } } } },
    "cursor"
  );
  assert.equal(cfg.token_budget_adapter, undefined);
});

test("setting mediated_commands true cannot bypass missing command broker capability", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-f3-allow-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-f3-ap-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-f3-apk-"));
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
    fs.writeFileSync(
      env.TEAM_UP_ROSTER,
      JSON.stringify({
        accounts: { cursor: { kind: "subscription", enabled: true } },
        clis: {
          cursor: {
            cmd: ["true", "{prompt}"],
            sandbox: { mediated_commands: true },
          },
        },
        models: {
          m: {
            tier: "medium",
            cli: ["cursor"],
            account: "cursor",
            reasoning: { low: null },
            priority: 1,
          },
        },
      })
    );
    fs.writeFileSync(env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));
    writePkg(
      pkg,
      validManifest({
        id: "testing.bypass",
        capabilities: { skills: [], tools: ["command.test"], mcps: [], frameworks: [] },
        permissions: {
          filesystem: "project_readonly",
          writes: false,
          network: false,
          commands: ["project-test"],
        },
      })
    );
    assert.equal((await installPackage(pkg, env)).ok, true);
    writeProjectCommands(project);
    assert.equal(
      (await approveSpecialist({ idAtVersion: "testing.bypass@0.1.0", project, env })).ok,
      true
    );

    await assert.rejects(
      () =>
        launch({
          specialistId: "testing.bypass",
          callType: "consult",
          objective: "run tests",
          project,
          env,
          dryRun: true,
          sandbox: { available: true, probe: () => true },
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

test("max_tokens is advisory and does not block launch", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-f3-tok-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-f3-tp-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-f3-tk-"));
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
    fs.writeFileSync(
      env.TEAM_UP_ROSTER,
      JSON.stringify({
        accounts: { cursor: { kind: "subscription", enabled: true } },
        clis: {
          cursor: {
            cmd: ["true", "{prompt}"],
            sandbox: { token_budget_adapter: true },
          },
        },
        models: {
          m: {
            tier: "medium",
            cli: ["cursor"],
            account: "cursor",
            reasoning: { low: null },
            priority: 1,
          },
        },
      })
    );
    fs.writeFileSync(env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));
    writePkg(
      pkg,
      validManifest({
        id: "testing.tokbypass",
        budget: { timeout_seconds: 60, max_tokens: 80000 },
      })
    );
    assert.equal((await installPackage(pkg, env)).ok, true);
    assert.equal(
      (await approveSpecialist({ idAtVersion: "testing.tokbypass@0.1.0", project, env })).ok,
      true
    );

    const result = await launch({
      specialistId: "testing.tokbypass",
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
      sandbox: { available: true, probe: () => true },
    });
    assert.equal(result.budget.tokens.target, 80000);
    assert.equal(result.budget.tokens.enforcement, "advisory");
    assert.equal(loadState(result.runId).budget.tokens.enforcement, "advisory");
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

test("approve v2 while project pinned to v1 (approve-before-repin)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-f3-pin-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-f3-pp-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  const pkg1 = fs.mkdtempSync(path.join(os.tmpdir(), "tu-f3-p1-"));
  const pkg2 = fs.mkdtempSync(path.join(os.tmpdir(), "tu-f3-p2-"));
  writePkg(pkg1, validManifest({ id: "testing.aprepin", version: "0.1.0" }));
  writePkg(
    pkg2,
    validManifest({ id: "testing.aprepin", version: "0.2.0", display_name: "V2" })
  );
  assert.equal((await installPackage(pkg1, env)).ok, true);
  assert.equal((await installPackage(pkg2, env)).ok, true);

  const pin = pinSpecialist("testing.aprepin", { version: "0.1.0", project, env });
  assert.equal(pin.ok, true);

  const ap2 = await approveSpecialist({
    idAtVersion: "testing.aprepin@0.2.0",
    project,
    env,
  });
  assert.equal(ap2.ok, true, ap2.errors?.join("; "));
  assert.equal(ap2.approval.version, "0.2.0");
  assert.ok(
    isApproved({
      project,
      id: "testing.aprepin",
      version: "0.2.0",
      checksum: ap2.approval.checksum,
      permissions: ap2.approval.permissions,
      env,
    })
  );

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(pkg1, { recursive: true, force: true });
  fs.rmSync(pkg2, { recursive: true, force: true });
});
