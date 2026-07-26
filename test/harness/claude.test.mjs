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
      cli_version: "test",
      command_broker: "team-up.command-broker/v1",
      context_isolation: "team-up.context-isolation/v1",
    },
    brokerBin: "/abs/bin/team-up-command-broker.mjs",
    nodePath: "/abs/node",
  });

  assert.equal(prepared.argv.includes("--dangerously-skip-permissions"), false);
  assert.equal(prepared.argv.includes("--effort"), true);
  assert.equal(prepared.argv[prepared.argv.indexOf("--disallowedTools") + 1], "Bash");
});

test("capsule launch uses bare mode and only explicit plugin and MCP paths", () => {
  const writes = new Map();
  const prepared = claudeAdapter.prepareLaunch({
    argv: ["claude", "-p", "work"],
    runDir: "/run",
    capsule: {
      pluginDirs: ["/run/harness/plugins/x"],
      mcpConfig: { mcpServers: { selected: {
        type: "stdio", command: "node", args: ["/run/harness/mcp/x/server.mjs"],
      } } },
      mcpToolNames: ["mcp__selected__lookup"],
      mcpToolsByServer: { selected: ["lookup"] },
      codexHome: "/run/harness/home",
    },
    writeFileSync: (file, text) => writes.set(file, text),
    mkdirSync: () => {},
    chmodSync: () => {},
  });
  assert.equal(prepared.argv.includes("--bare"), true);
  assert.deepEqual(prepared.argv.slice(
    prepared.argv.indexOf("--plugin-dir"),
    prepared.argv.indexOf("--plugin-dir") + 2
  ), ["--plugin-dir", "/run/harness/plugins/x"]);
  assert.equal(prepared.argv.includes("--strict-mcp-config"), true);
  assert.match(writes.get("/run/harness/claude-mcp.json"), /"selected"/);
  assert.match(prepared.argv.join(" "), /mcp__selected__lookup/);
});

test("capsule launch adds skill and framework dirs via --add-dir", () => {
  const prepared = claudeAdapter.prepareLaunch({
    argv: ["claude", "-p", "work"],
    runDir: "/run",
    capsule: {
      pluginDirs: [],
      skillDirs: ["/run/context/skills"],
      frameworkDirs: ["/run/context/framework"],
      mcpConfig: { mcpServers: {} },
      mcpToolNames: [],
    },
    writeFileSync: () => {},
    mkdirSync: () => {},
    chmodSync: () => {},
  });
  assert.equal(prepared.argv.includes("--add-dir"), true);
  assert.equal(prepared.argv.includes("/run/context/skills"), true);
  assert.equal(prepared.argv.includes("/run/context/framework"), true);
});
