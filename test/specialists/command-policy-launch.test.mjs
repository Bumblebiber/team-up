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
import { builtinsForPermissions } from "../../src/specialists/permissions.mjs";
import { prepareHarnessLaunch } from "../../src/harness/registry.mjs";

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

function materializeDemoCapsule({ runRoot }) {
  const rel = "harness/mcp/demo.json";
  const mcpPath = path.join(runRoot, rel);
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, JSON.stringify({
    mcpServers: {
      demo_server: { command: process.execPath, args: [], tools: ["lookup-one"] },
    },
  }));
  return {
    packages: [{ resolved: { plugins: [], mcps: [rel] } }],
    exclusions: [],
  };
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
      dryRun: false,
      admission: "check",
      dependencyOverrides: {
        harnessCapabilities: () => ({
          command_broker: COMMAND_BROKER,
          context_isolation: CONTEXT_ISOLATION,
          native_shell: "denied",
          mcp: "stdio",
        }),
        resolveEffectiveCapabilities: () => ({ packages: [], exclusions: [] }),
        checkAdmission: async () => ({ ok: true }),
        harnessStatus: () => ({ cli: "claude", installed_version: "2.1.300", status: "no_record" }),
      },
    };

    await assert.rejects(() => launch(args), (error) => {
      assert.equal(error.code, "COMMAND_POLICY_UNTRUSTED");
      assert.match(error.message, /team-up specialist trust-policy --project/);
      return true;
    });

    const trust = trustProjectPolicy({ project, env });
    assert.equal(trust.ok, true, trust.errors?.join("; "));
    const roster = JSON.parse(fs.readFileSync(env.TEAM_UP_ROSTER, "utf8"));
    roster.clis.claude.cmd = [
      "claude", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "{prompt}",
    ];
    fs.writeFileSync(env.TEAM_UP_ROSTER, JSON.stringify(roster));

    let prepares = 0;
    let homeInodeAtStart = null;
    let started = null;
    const warnings = [];
    const priorError = console.error;
    console.error = (line) => warnings.push(String(line));
    let result;
    try {
      result = await launch({
        ...args,
        dependencyOverrides: {
          ...args.dependencyOverrides,
          materializeCapabilityCapsule: materializeDemoCapsule,
          prepareHarnessLaunch: (options) => {
            prepares += 1;
            return prepareHarnessLaunch(options);
          },
          startInTmux: (options) => {
            started = options;
            homeInodeAtStart = fs.statSync(path.join(env.TEAM_UP_RUNS, options.runId, "claude-home")).ino;
          },
        },
      });
    } finally {
      console.error = priorError;
    }
    assert.ok(result.runId);
    assert.deepEqual(result.permissions.commands, ["project-test"]);
    assert.equal(loadState(result.runId).command_policy.checksum, trust.checksum);
    assert.equal(prepares, 1);
    assert.deepEqual(started.argv, result.argv);
    const runHome = path.join(env.TEAM_UP_RUNS, result.runId, "claude-home");
    assert.equal(fs.statSync(runHome).ino, homeInodeAtStart, "Claude HOME was not rebuilt after tmux start");
    assert.deepEqual(warnings, [
      "warning: claude 2.1.300 harness verification no_record; launch continues. Run team-up harness verify claude.",
    ]);
    assert.equal(
      loadState(result.runId).harness_warning,
      "claude 2.1.300 harness verification no_record; launch continues. Run team-up harness verify claude."
    );

    assert.deepEqual(result.argv.slice(0, 4), [
      "timeout", "--signal=TERM", "--kill-after=5s", "60s",
    ]);
    assert.equal(result.argv[4], "env");
    assert.equal(result.argv[5], `HOME=${runHome}`);
    const tools = [
      ...builtinsForPermissions(result.permissions),
      ...result.permissions.commands.map((id) => `mcp__team_up_command_broker__${id.replace(/-/g, "_")}`),
      "mcp__demo_server__lookup_one",
    ].join(",");
    for (const flag of ["--tools", "--allowedTools"]) {
      const value = result.argv[result.argv.indexOf(flag) + 1];
      assert.equal(value, tools, `${flag} must equal capsule allowlist`);
      assert.doesNotMatch(value, /\b(Edit|Bash)\b/);
    }
    const denied = result.argv[result.argv.indexOf("--disallowedTools") + 1].split(",");
    assert.equal(denied[0], "Bash");
    assert.ok(denied.some((rule) => rule.includes(".ssh/**")));
    assert.ok(denied.some((rule) => rule.includes(".mcp.json")));
    assert.ok(result.argv.includes("--strict-mcp-config"));
    assert.deepEqual(result.argv.slice(result.argv.indexOf("--setting-sources"), result.argv.indexOf("--setting-sources") + 2), [
      "--setting-sources", "user",
    ]);
    assert.equal(result.argv.includes("--dangerously-skip-permissions"), false);
    assert.equal(result.argv.some((item, index) => item === "--permission-mode" && result.argv[index + 1] === "bypassPermissions"), false);

    let dryRunPrepares = 0;
    let dryRunStarts = 0;
    const dryRunWarnings = [];
    console.error = (line) => dryRunWarnings.push(String(line));
    let dryRunResult;
    try {
      dryRunResult = await launch({
        ...args,
        dryRun: true,
        objective: "print dry-run capsule argv",
        dependencyOverrides: {
          ...args.dependencyOverrides,
          materializeCapabilityCapsule: materializeDemoCapsule,
          prepareHarnessLaunch: (options) => {
            dryRunPrepares += 1;
            return prepareHarnessLaunch(options);
          },
          startInTmux: () => { dryRunStarts += 1; },
        },
      });
    } finally {
      console.error = priorError;
    }
    assert.equal(dryRunPrepares, 1);
    assert.equal(dryRunStarts, 0);
    assert.equal(dryRunWarnings.length, 1);
    assert.equal(loadState(dryRunResult.runId).status, "cancelled");
    assert.deepEqual(dryRunResult.argv.slice(0, 6), [
      "timeout", "--signal=TERM", "--kill-after=5s", "60s", "env",
      `HOME=${path.join(env.TEAM_UP_RUNS, dryRunResult.runId, "claude-home")}`,
    ]);
    assert.equal(dryRunResult.argv.includes("--strict-mcp-config"), true);
    assert.equal(dryRunResult.argv.includes("--dangerously-skip-permissions"), false);
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
