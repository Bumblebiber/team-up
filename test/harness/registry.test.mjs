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
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";

test("claude advertises brokered commands; unverified harnesses do not", () => {
  assert.equal(declaredHarnessCapabilities("claude").command_broker, "team-up.command-broker/v1");
  assert.equal(harnessCapabilities("claude", { verification: null }).command_broker, null);
  assert.equal(
    harnessCapabilities("claude", { verification: { status: "verified", cli_version: "fixture" } }).command_broker,
    "team-up.command-broker/v1"
  );
  for (const id of ["cursor", "codex", "hermes", "opencode"]) {
    assert.equal(harnessCapabilities(id).command_broker, null);
  }
});

test("unknown harness fails closed", () => {
  assert.throws(() => prepareHarnessLaunch({ cli: "unknown" }), /HARNESS_UNSUPPORTED/);
});

test("unverified harness never advertises context isolation", () => {
  assert.equal(
    defaultHarnessCapabilities("claude", { verification: null }).context_isolation,
    null
  );
  for (const id of ["cursor", "codex", "hermes", "opencode"]) {
    assert.equal(defaultHarnessCapabilities(id).context_isolation, null);
  }
});

test("verified Claude advertises the versioned contract", () => {
  assert.equal(
    defaultHarnessCapabilities("claude", {
      verification: { status: "verified", cli_version: "fixture" },
    }).context_isolation,
    CONTEXT_ISOLATION_CAPABILITY
  );
  assert.equal(
    declaredHarnessCapabilities("claude").context_isolation,
    CONTEXT_ISOLATION_CAPABILITY
  );
});

test("a capsule launch on an unverified harness fails closed", () => {
  assert.throws(
    () =>
      prepareHarnessLaunch({
        cli: "claude",
        argv: ["claude", "-p", "work"],
        runDir: "/run",
        capsule: { pluginDirs: [], mcpConfig: { mcpServers: {} } },
        verification: null,
      }),
    /HARNESS_CONTEXT_ISOLATION_UNVERIFIED/
  );
});

test("a verified capsule launch without a broker still isolates", () => {
  const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tu-caps-")));
  const prepared = prepareHarnessLaunch({
    cli: "claude",
    argv: ["claude", "--model", "opus", "work"],
    runDir,
    capsule: {
      pluginDirs: [`${runDir}/harness/plugins/x`],
      mcpConfig: { mcpServers: { selected: { type: "stdio", command: "node" } } },
      homeDir: `${runDir}/harness/home`,
    },
    verification: { status: "verified", cli_version: "fixture" },
  });
  assert.equal(prepared.argv.includes("--strict-mcp-config"), true);
  assert.equal(prepared.env.CLAUDE_CONFIG_DIR, `${runDir}/harness/home`);
  assert.equal(prepared.capabilities.context_isolation, CONTEXT_ISOLATION_CAPABILITY);
});
