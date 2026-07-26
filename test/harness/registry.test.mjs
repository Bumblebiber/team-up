import test from "node:test";
import assert from "node:assert/strict";
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
    harnessCapabilities("claude", {
      verification: {
        status: "verified",
        adapter: "claude",
        cli_version: "fixture",
        command_broker: "team-up.command-broker/v1",
      },
    }).command_broker,
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
  assert.equal(defaultHarnessCapabilities("claude", {
    verification: null,
  }).context_isolation, null);
});

test("verified Claude advertises the versioned contract", () => {
  assert.equal(defaultHarnessCapabilities("claude", {
    verification: {
      status: "verified",
      adapter: "claude",
      cli_version: "2.1.220",
      context_isolation: CONTEXT_ISOLATION_CAPABILITY,
    },
  }).context_isolation, CONTEXT_ISOLATION_CAPABILITY);
});

test("Codex declared context_isolation requires matching verification", () => {
  assert.equal(declaredHarnessCapabilities("codex").context_isolation, CONTEXT_ISOLATION_CAPABILITY);
  assert.equal(harnessCapabilities("codex", {
    verification: null,
  }).context_isolation, null);
  assert.equal(harnessCapabilities("codex", {
    verification: {
      status: "verified",
      adapter: "codex",
      cli_version: "0.145.0",
      context_isolation: CONTEXT_ISOLATION_CAPABILITY,
    },
  }).context_isolation, CONTEXT_ISOLATION_CAPABILITY);
});

test("Claude verification record cannot be reused under Codex runtime", () => {
  assert.equal(harnessCapabilities("codex", {
    verification: {
      status: "verified",
      adapter: "claude",
      cli_version: "2.1.220",
      context_isolation: CONTEXT_ISOLATION_CAPABILITY,
      command_broker: "team-up.command-broker/v1",
    },
  }).context_isolation, null);
  assert.throws(() => prepareHarnessLaunch({
    cli: "codex",
    argv: ["codex", "exec", "x"],
    runDir: "/run",
    capsule: {
      pluginDirs: [],
      skillDirs: [],
      codexHome: "/run/harness/home",
      mcpConfig: { mcpServers: {} },
    },
    verification: {
      status: "verified",
      adapter: "claude",
      cli_version: "2.1.220",
      context_isolation: CONTEXT_ISOLATION_CAPABILITY,
    },
  }), /HARNESS_CONTEXT_ISOLATION_UNVERIFIED|HARNESS_VERIFICATION_ADAPTER/);
});

test("verification adapter/version mismatch fails closed", () => {
  assert.equal(harnessCapabilities("claude", {
    verification: {
      status: "verified",
      adapter: "claude",
      cli_version: "2.1.219",
      context_isolation: CONTEXT_ISOLATION_CAPABILITY,
    },
    requireExactVersion: "2.1.220",
  }).context_isolation, null);
  assert.equal(harnessCapabilities("claude", {
    verification: {
      status: "verified",
      adapter: "claude",
      cli_version: "2.1.220",
      context_isolation: CONTEXT_ISOLATION_CAPABILITY,
    },
    requireExactVersion: "2.1.220",
  }).context_isolation, CONTEXT_ISOLATION_CAPABILITY);
});

test("exact adapter and version match preserves verified Claude isolation", () => {
  assert.equal(harnessCapabilities("claude", {
    verification: {
      status: "verified",
      adapter: "claude",
      cli_version: "2.1.220",
      context_isolation: CONTEXT_ISOLATION_CAPABILITY,
      command_broker: "team-up.command-broker/v1",
    },
    requireExactVersion: "2.1.220",
  }).context_isolation, CONTEXT_ISOLATION_CAPABILITY);
});

test("Cursor Hermes and OpenCode remain ineligible without adapters", () => {
  for (const id of ["cursor", "hermes", "opencode"]) {
    assert.equal(harnessCapabilities(id, {
      verification: { status: "verified" },
    }).context_isolation, null);
  }
});

test("verified broker-only record does not grant context isolation", () => {
  assert.equal(harnessCapabilities("claude", {
    verification: {
      status: "verified",
      adapter: "claude",
      cli_version: "2.1.220",
      command_broker: "team-up.command-broker/v1",
      context_isolation: null,
    },
  }).context_isolation, null);
  assert.equal(harnessCapabilities("claude", {
    verification: {
      status: "verified",
      adapter: "claude",
      cli_version: "2.1.220",
      command_broker: "team-up.command-broker/v1",
      context_isolation: CONTEXT_ISOLATION_CAPABILITY,
    },
  }).context_isolation, CONTEXT_ISOLATION_CAPABILITY);
});

test("capsule launch without proven isolation fails closed", () => {
  assert.throws(() => prepareHarnessLaunch({
    cli: "claude",
    argv: ["claude", "-p", "x"],
    runDir: "/run",
    capsule: { pluginDirs: [], mcpConfig: { mcpServers: {} } },
    verification: {
      status: "verified",
      adapter: "claude",
      cli_version: "2.1.220",
      command_broker: "team-up.command-broker/v1",
      context_isolation: null,
    },
  }), /HARNESS_CONTEXT_ISOLATION_UNVERIFIED/);
});
