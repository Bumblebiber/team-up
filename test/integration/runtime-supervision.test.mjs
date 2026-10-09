import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { installPackage } from "../../src/specialists/store.mjs";
import { isPolicyTrusted, trustProjectPolicy } from "../../src/specialists/approvals.mjs";
import { resolveProfile } from "../../src/roster/profile.mjs";
import { commandPolicyChecksum } from "../../src/commands/policy.mjs";
import { normalizeBudget } from "../../src/specialists/budget.mjs";
import { findSpecialistRepos } from "../helpers/specialist-repos.mjs";

const REPOS = findSpecialistRepos(path.dirname(fileURLToPath(import.meta.url)));
const TESSA = path.join(REPOS, "team-up-with-tessa");
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
          cli: ["claude"],
          account: "claude",
          reasoning: { max: "max" },
          priority: 1,
          limit_windows: ["claude:5h"],
        },
        "frontier-cursor": {
          cli: ["cursor"],
          account: "cursor",
          reasoning: { max: "xhigh" },
          priority: 2,
        },
        "high-x": {
          cli: ["claude"],
          account: "claude",
          reasoning: { max: "max" },
          priority: 1,
        },
      },
      // high-x runs on claude too but is off Tessa's chain.
      roles: { reviewer: { chain: ["claude:frontier-claude", "cursor:frontier-cursor"] } },
      specialists: { "testing.tessa": { role: "reviewer" } },
    };
    fs.writeFileSync(env.TEAM_UP_ROSTER, JSON.stringify(roster));
    fs.writeFileSync(env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));

    const inst = await installPackage(TESSA, env);
    assert.equal(inst.ok, true, inst.errors?.join("; "));
    const trusted = trustProjectPolicy({ project, env });
    assert.equal(trusted.ok, true, trusted.errors?.join("; "));
    const checksum = commandPolicyChecksum(policy);
    assert.equal(trusted.checksum, checksum);
    assert.equal(isPolicyTrusted({ checksum, env }), true);
    assert.equal(isPolicyTrusted({ checksum: "sha256:changed", env }), false);

    const resolved = resolveProfile({
      roster,
      usage: {},
      specialistId: "testing.tessa",
      requirements: { command_broker: "team-up.command-broker/v1" },
      harnessCapabilities: (cli) =>
        cli === "claude"
          ? { command_broker: "team-up.command-broker/v1" }
          : { command_broker: null },
    });
    assert.deepEqual(resolved.chain.map((c) => c.cli), ["claude"]);
    assert.ok(!resolved.chain.some((c) => c.model === "high-x"));
    assert.ok(resolved.skipped.some((sk) =>
      sk.model === "cursor:frontier-cursor" && /command broker unavailable/.test(sk.reason)));

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

  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
