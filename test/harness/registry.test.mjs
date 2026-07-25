import test from "node:test";
import assert from "node:assert/strict";
import {
  declaredHarnessCapabilities,
  harnessCapabilities,
  prepareHarnessLaunch,
} from "../../src/harness/registry.mjs";

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
