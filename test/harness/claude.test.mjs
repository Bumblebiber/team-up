import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAdapter, materializeClaudeAuthHome } from "../../src/harness/claude.mjs";
import { prepareHarnessLaunch } from "../../src/harness/registry.mjs";

test("claude prepareLaunch denies shell bypass and writes mcp config", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-claude-"));
  const files = [];
  const prepared = claudeAdapter.prepareLaunch({
    argv: ["claude", "--model", "opus", "do work"],
    runDir,
    broker: {
      policySnapshot: "/abs/policy/commands.json",
      policyChecksum: "sha256:test",
      project: "/abs/project",
      runDir: "/abs/run",
      actionIds: ["project-test"],
    },
    brokerBin: "/abs/bin/team-up-command-broker.mjs",
    nodePath: "/abs/node",
    writeFileSync: (p, body, opts) => {
      files.push({ p, body, opts });
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body, opts);
    },
    mkdirSync: fs.mkdirSync,
    chmodSync: fs.chmodSync,
  });
  assert.ok(prepared.argv.includes("--strict-mcp-config"));
  assert.ok(prepared.argv.includes("--disallowedTools"));
  const denied = prepared.argv[prepared.argv.indexOf("--disallowedTools") + 1].split(",");
  assert.ok(denied.includes("Bash"));
  // Credential files are denied whether or not the broker is attached.
  assert.ok(denied.some((r) => r.endsWith("/.mcp.json)")));
  assert.ok(denied.some((r) => r.endsWith("/.ssh/**)")));
  assert.match(prepared.argv.join(" "), /mcp__team_up_command_broker__project_test/);
  assert.equal(fs.statSync(prepared.files[0]).mode & 0o222, 0);
  assert.throws(
    () =>
      claudeAdapter.prepareLaunch({
        argv: ["claude", "--dangerously-skip-permissions"],
        runDir,
        broker: {
          policySnapshot: "/p",
          project: "/proj",
          runDir: "/r",
          actionIds: [],
        },
        writeFileSync: () => {},
        mkdirSync: () => {},
        chmodSync: () => {},
      }),
    /HARNESS_POLICY/
  );
});

test("claude injectControl uses tmux argv not a shell", () => {
  const calls = [];
  claudeAdapter.injectControl({
    tmuxSession: "s1",
    message: "please checkpoint",
    execFileSync: (cmd, args) => {
      calls.push([cmd, ...args]);
    },
  });
  assert.deepEqual(calls[0], ["tmux", "send-keys", "-t", "s1", "-l", "please checkpoint"]);
  assert.deepEqual(calls[1], ["tmux", "send-keys", "-t", "s1", "Enter"]);
});

test("brokered Claude launch strips legacy roster bypass before enforcing policy", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-claude-legacy-"));
  const prepared = prepareHarnessLaunch({
    cli: "claude",
    argv: [
      "claude",
      "--dangerously-skip-permissions",
      "--model",
      "opus",
      "--effort",
      "max",
      "do work",
    ],
    runDir,
    broker: {
      policySnapshot: "/abs/policy/commands.json",
      policyChecksum: "sha256:test",
      project: "/abs/project",
      runDir: "/abs/run",
      actionIds: ["project-test"],
    },
    verification: {
      status: "verified",
      adapter: "claude",
      cli_version: "test",
      command_broker: "team-up.command-broker/v1",
      context_isolation: "team-up.context-isolation/v1",
    },
    brokerBin: "/abs/bin/team-up-command-broker.mjs",
    nodePath: "/abs/node",
  });

  assert.equal(prepared.argv.includes("--dangerously-skip-permissions"), false);
  assert.equal(prepared.argv.includes("--effort"), true);
  assert.ok(
    prepared.argv[prepared.argv.indexOf("--disallowedTools") + 1].split(",").includes("Bash")
  );
});

test("capsule launch uses auth-only HOME and only explicit plugin and MCP paths", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-claude-launch-"));
  try {
    const writes = new Map();
    const prepared = claudeAdapter.prepareLaunch({
      argv: ["claude", "-p", "work"],
      runDir,
      capsule: {
        pluginDirs: [`${runDir}/harness/plugins/x`],
        mcpConfig: { mcpServers: { selected: {
          type: "stdio", command: process.execPath, args: [`${runDir}/harness/mcp/x/server.mjs`],
        } } },
        mcpToolNames: ["mcp__selected__lookup"],
        mcpToolsByServer: { selected: ["lookup"] },
        codexHome: `${runDir}/harness/home`,
      },
      writeFileSync: (file, text) => writes.set(file, text),
      mkdirSync: (d, o) => fs.mkdirSync(d, o),
      chmodSync: () => {},
    });
    assert.equal(prepared.argv.includes("--bare"), false);
    assert.ok(prepared.env.HOME);
    assert.match(prepared.env.HOME, /claude-home$/);
    assert.deepEqual(prepared.argv.slice(
      prepared.argv.indexOf("--plugin-dir"),
      prepared.argv.indexOf("--plugin-dir") + 2
    ), ["--plugin-dir", `${runDir}/harness/plugins/x`]);
    assert.equal(prepared.argv.includes("--strict-mcp-config"), true);
    assert.match(writes.get(`${runDir}/harness/claude-mcp.json`), /"selected"/);
    assert.match(prepared.argv.join(" "), /mcp__selected__lookup/);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("capsule launch materializes skills into HOME and frameworks via --add-dir", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-claude-add-dir-"));
  try {
    const skillDir = path.join(runDir, "context", "skills", "capsule.selected-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# skill\n");
    const prepared = claudeAdapter.prepareLaunch({
      argv: ["claude", "-p", "work"],
      runDir,
      capsule: {
        pluginDirs: [],
        skillDirs: [path.join(runDir, "context", "skills")],
        frameworkDirs: [`${runDir}/context/framework`],
        mcpConfig: { mcpServers: {} },
        mcpToolNames: [],
      },
      writeFileSync: () => {},
      mkdirSync: (d, o) => fs.mkdirSync(d, o),
      chmodSync: () => {},
    });
    assert.equal(prepared.argv.includes("--add-dir"), true);
    assert.equal(prepared.argv.includes(`${runDir}/context/skills`), false);
    assert.equal(prepared.argv.includes(`${runDir}/context/framework`), true);
    assert.ok(prepared.env.HOME);
    assert.equal(
      fs.existsSync(path.join(prepared.env.HOME, ".claude", "skills", "capsule.selected-skill", "SKILL.md")),
      true
    );
    assert.ok(prepared.home_generation);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("the materialized home clears both headless-fatal first-run gates", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "tu-claude-src-"));
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "tu-claude-run-"));
  fs.mkdirSync(path.join(source, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(source, ".claude", ".credentials.json"), '{"token":"x"}');
  fs.writeFileSync(
    path.join(source, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, numStartups: 7, oauthAccount: "secret" })
  );

  const materialized = materializeClaudeAuthHome(run, {
    authSourceHome: source,
    workspaceDirs: [path.join(run, "context")],
  });
  const seeded = JSON.parse(
    fs.readFileSync(path.join(materialized.home, ".claude.json"), "utf8")
  );

  // Gate one: the onboarding wizard.
  assert.equal(seeded.hasCompletedOnboarding, true);
  assert.equal(seeded.numStartups, 7);
  // Gate two: the workspace trust prompt for the run's own directories.
  assert.equal(seeded.projects[path.join(run, "context")].hasTrustDialogAccepted, true);
  // Only the markers travel — nothing else from the user's config.
  assert.equal(seeded.oauthAccount, undefined);

  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(run, { recursive: true, force: true });
});
