import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAdapter } from "../../src/harness/claude.mjs";
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
  assert.equal(prepared.argv[prepared.argv.indexOf("--disallowedTools") + 1], "Bash");
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

test("capsule launch uses only explicit plugin, MCP and config-dir paths", () => {
  const writes = new Map();
  const prepared = claudeAdapter.prepareLaunch({
    argv: ["claude", "-p", "work"],
    runDir: "/run",
    broker: null,
    capsule: {
      pluginDirs: ["/run/harness/plugins/x"],
      mcpConfig: {
        mcpServers: {
          selected: {
            type: "stdio",
            command: "node",
            args: ["/run/harness/mcp/x/server.mjs"],
          },
        },
      },
      mcpToolNames: ["mcp__selected__do_thing"],
      homeDir: "/run/harness/home",
    },
    writeFileSync: (file, text) => writes.set(file, text),
    mkdirSync: () => {},
    chmodSync: () => {},
  });

  assert.deepEqual(
    prepared.argv.slice(
      prepared.argv.indexOf("--plugin-dir"),
      prepared.argv.indexOf("--plugin-dir") + 2
    ),
    ["--plugin-dir", "/run/harness/plugins/x"]
  );
  assert.equal(prepared.argv.includes("--strict-mcp-config"), true);
  assert.match(writes.get("/run/harness/claude-mcp.json"), /"selected"/);
  // No broker in this launch: the broker server must not be configured.
  assert.doesNotMatch(
    writes.get("/run/harness/claude-mcp.json"),
    /team_up_command_broker/
  );
  const tools = prepared.argv[prepared.argv.indexOf("--tools") + 1];
  assert.match(tools, /mcp__selected__do_thing/);
  // A run-specific config dir replaces user-global skills, plugins and settings.
  assert.equal(prepared.env.CLAUDE_CONFIG_DIR, "/run/harness/home");
});

test("bare mode is opt-in because it never reads subscription auth", () => {
  const base = {
    argv: ["claude", "-p", "work"],
    runDir: "/run",
    broker: null,
    writeFileSync: () => {},
    mkdirSync: () => {},
    chmodSync: () => {},
  };
  const oauth = claudeAdapter.prepareLaunch({
    ...base,
    capsule: { pluginDirs: [], mcpConfig: { mcpServers: {} } },
  });
  assert.equal(oauth.argv.includes("--bare"), false);

  const apiKey = claudeAdapter.prepareLaunch({
    ...base,
    capsule: { pluginDirs: [], mcpConfig: { mcpServers: {} }, bare: true },
  });
  assert.equal(apiKey.argv.includes("--bare"), true);
});

test("capsule and broker compose without leaking global MCP names", () => {
  const writes = new Map();
  const prepared = claudeAdapter.prepareLaunch({
    argv: ["claude", "-p", "work"],
    runDir: "/run",
    broker: {
      policySnapshot: "/abs/policy/commands.json",
      policyChecksum: "sha256:test",
      project: "/abs/project",
      runDir: "/abs/run",
      actionIds: ["project-test"],
    },
    brokerBin: "/abs/bin/broker.mjs",
    nodePath: "/abs/node",
    capsule: {
      pluginDirs: [],
      mcpConfig: { mcpServers: { selected: { type: "stdio", command: "node" } } },
      mcpToolNames: ["mcp__selected__do_thing"],
    },
    writeFileSync: (file, text) => writes.set(file, text),
    mkdirSync: () => {},
    chmodSync: () => {},
  });
  const config = JSON.parse(writes.get("/run/harness/claude-mcp.json"));
  assert.deepEqual(Object.keys(config.mcpServers).sort(), [
    "selected",
    "team_up_command_broker",
  ]);
  const tools = prepared.argv[prepared.argv.indexOf("--tools") + 1].split(",");
  assert.deepEqual(tools.filter((name) => name.startsWith("mcp__")).sort(), [
    "mcp__selected__do_thing",
    "mcp__team_up_command_broker__project_test",
  ]);
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
    verification: { status: "verified", cli_version: "test" },
    brokerBin: "/abs/bin/team-up-command-broker.mjs",
    nodePath: "/abs/node",
  });

  assert.equal(prepared.argv.includes("--dangerously-skip-permissions"), false);
  assert.equal(prepared.argv.includes("--effort"), true);
  assert.equal(prepared.argv[prepared.argv.indexOf("--disallowedTools") + 1], "Bash");
});
