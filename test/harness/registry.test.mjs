import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  declaredHarnessCapabilities,
  defaultHarnessCapabilities,
  harnessCapabilities,
  prepareHarnessLaunch,
} from "../../src/harness/registry.mjs";
import {
  COMMAND_BROKER_CAPABILITY,
  CONTEXT_ISOLATION_CAPABILITY,
} from "../../src/harness/capabilities.mjs";

test("Claude launch capabilities come from adapter declarations, independent of verification", () => {
  assert.deepEqual(declaredHarnessCapabilities("claude"), {
    command_broker: COMMAND_BROKER_CAPABILITY,
    context_isolation: CONTEXT_ISOLATION_CAPABILITY,
    native_shell: "denied",
    mcp: "stdio",
  });
  for (const verification of [null, { status: "failed" }, { status: "verified", adapter: "elsewhere" }]) {
    assert.deepEqual(harnessCapabilities("claude", { verification }), declaredHarnessCapabilities("claude"));
  }
  assert.deepEqual(defaultHarnessCapabilities("claude", { verification: null }), declaredHarnessCapabilities("claude"));
});

test("unsupported fallback declares no capsule or broker capabilities", () => {
  for (const id of ["cursor", "codex", "hermes", "opencode", "unknown"]) {
    assert.equal(harnessCapabilities(id).command_broker, null);
    assert.equal(harnessCapabilities(id).context_isolation, null);
  }
});

test("Claude capsule launch is prepared without a verification record", (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-harness-capsule-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const prepared = prepareHarnessLaunch({
    cli: "claude",
    argv: ["claude", "--dangerously-skip-permissions", "--", "task"],
    runDir,
    capsule: {
      pluginDirs: [],
      skillDirs: [],
      workspaceDirs: [],
      mcpConfig: { mcpServers: {} },
      mcpToolNames: [],
    },
    allowedBuiltins: ["Read", "Write"],
    env: { TEAM_UP_HOME: path.join(runDir, "team-up-home") },
    verification: { status: "failed" },
  });
  assert.ok(fs.existsSync(path.join(runDir, "claude-home", ".claude", ".credentials.json")));
  assert.equal(prepared.argv.includes("--dangerously-skip-permissions"), false);
  assert.equal(prepared.argv[prepared.argv.indexOf("--tools") + 1], "Read,Write");
  assert.equal(prepared.capabilities.context_isolation, CONTEXT_ISOLATION_CAPABILITY);
});

test("unsupported fallback cannot prepare a capsule", () => {
  assert.throws(() => prepareHarnessLaunch({
    cli: "codex",
    argv: ["codex", "task"],
    runDir: "/tmp/run",
    capsule: { mcpConfig: { mcpServers: {} } },
  }), /HARNESS_CONTEXT_ISOLATION_UNSUPPORTED/);
});
