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
  assert.equal(defaultHarnessCapabilities("claude", {
    verification: null,
  }).context_isolation, null);
});

test("verified Claude advertises the versioned contract", () => {
  assert.equal(defaultHarnessCapabilities("claude", {
    verification: { status: "verified" },
  }).context_isolation, CONTEXT_ISOLATION_CAPABILITY);
});

test("Codex isolation is eligible only with a matching verification record", () => {
  assert.equal(harnessCapabilities("codex", {
    verification: null,
  }).context_isolation, null);
  assert.equal(harnessCapabilities("codex", {
    verification: { status: "verified", version: "0.145.0" },
  }).context_isolation, "team-up.context-isolation/v1");
});

test("Cursor Hermes and OpenCode remain ineligible without adapters", () => {
  for (const id of ["cursor", "hermes", "opencode"]) {
    assert.equal(harnessCapabilities(id, {
      verification: { status: "verified" },
    }).context_isolation, null);
  }
});
