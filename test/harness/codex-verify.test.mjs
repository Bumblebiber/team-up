import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexAdapter } from "../../src/harness/codex.mjs";
import { verifyHarness, loadVerificationRecord } from "../../src/harness/verify.mjs";
import { liveCodexVerifyRunner } from "../../src/harness/cli-verify.mjs";

test("verifyHarness marks codex verified when inventory proves shell absent", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-codex-verify-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  const record = await verifyHarness({
    adapter: codexAdapter,
    fixtureProject: "/tmp/fixture",
    env,
    now: "2026-10-15T00:00:00Z",
    runner: Object.assign(
      async () => ({
        native_shell: "denied",
        broker_tool: null,
        tool_inventory: ["read_file", "apply_patch"],
      }),
      { execFileSync: () => "0.162.1\n" }
    ),
  });
  assert.equal(record.status, "verified");
  assert.equal(record.native_shell, "denied");
  assert.equal(loadVerificationRecord("codex", "0.162.1", env).status, "verified");
  fs.rmSync(home, { recursive: true, force: true });
});

test("liveCodexVerifyRunner uses adapter toolInventory hook", async () => {
  const adapter = {
    ...codexAdapter,
    toolInventory: async () => ["read_file"],
    prepareLaunch: codexAdapter.prepareLaunch,
  };
  const result = await liveCodexVerifyRunner({
    adapter,
    fixtureProject: "/tmp",
    cliVersion: "0.0.0",
  });
  assert.equal(result.native_shell, "denied");
  assert.ok(Array.isArray(result.tool_inventory));
});
