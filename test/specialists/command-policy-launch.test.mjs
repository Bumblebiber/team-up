import "../helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "../../src/specialists/launcher.mjs";
import { installPackage } from "../../src/specialists/store.mjs";
import { trustProjectPolicy } from "../../src/specialists/approvals.mjs";
import { loadState } from "../../src/runs/runs.mjs";

const COMMAND_BROKER = "team-up.command-broker/v1";
const CONTEXT_ISOLATION = "team-up.context-isolation/v1";

const policy = {
  schema_version: 1,
  commands: {
    "project-test": {
      argv: ["npm", "test"],
      cwd: ".",
      timeout_seconds: 1800,
      environment: {},
    },
  },
};

function writeProjectPolicy(project, value = policy) {
  const dir = path.join(project, ".team-up");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify(value));
}

function writePackage(dir) {
  fs.writeFileSync(path.join(dir, "specialist.json"), JSON.stringify({
    schema_version: 1,
    id: "testing.commandpolicy",
    display_name: "CommandPolicy",
    version: "0.1.0",
    remit: ["x"],
    anti_remit: ["y"],
    call_types: ["consult"],
    accepted_inputs: ["task_description"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: ["command.test"], mcps: [], frameworks: [] },
    permissions: {
      filesystem: "project_readonly",
      writes: false,
      network: false,
      commands: ["project-test"],
    },
    budget: { timeout_seconds: 60 },
    eval_suite: "evals/evals.json",
  }));
  fs.writeFileSync(path.join(dir, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evals", "evals.json"), "[]");
}

test("untrusted project policy refuses command launch; trust-policy enables it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-command-policy-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-command-policy-project-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-command-policy-package-"));
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
      accounts: { anthropic: { kind: "subscription", enabled: true } },
      clis: { claude: { cmd: ["claude", "{prompt}"] } },
      models: {
        m: { cli: ["claude"], account: "anthropic", reasoning: { low: null }, priority: 1 },
      },
      specialists: { "testing.commandpolicy": { chain: ["claude:m"] } },
    }));
    fs.writeFileSync(env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));
    writeProjectPolicy(project);
    writePackage(pkg);
    assert.equal((await installPackage(pkg, env)).ok, true);

    const args = {
      specialistId: "testing.commandpolicy",
      callType: "consult",
      objective: "run project tests",
      project,
      env,
      dryRun: true,
      sandbox: { available: true, probe: () => true },
      dependencyOverrides: {
        harnessCapabilities: () => ({
          command_broker: COMMAND_BROKER,
          context_isolation: CONTEXT_ISOLATION,
          native_shell: "denied",
          mcp: "stdio",
        }),
        prepareHarnessLaunch: ({ argv }) => ({ argv, env: {}, files: [] }),
        resolveEffectiveCapabilities: () => ({ packages: [], exclusions: [] }),
      },
    };

    await assert.rejects(() => launch(args), (error) => {
      assert.equal(error.code, "COMMAND_POLICY_UNTRUSTED");
      assert.match(error.message, /team-up specialist trust-policy --project/);
      return true;
    });

    const trust = trustProjectPolicy({ project, env });
    assert.equal(trust.ok, true, trust.errors?.join("; "));
    const result = await launch(args);
    assert.ok(result.runId);
    assert.deepEqual(result.permissions.commands, ["project-test"]);
    assert.equal(loadState(result.runId).command_policy.checksum, trust.checksum);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in prev)) delete process.env[key];
    }
    Object.assign(process.env, prev);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});
