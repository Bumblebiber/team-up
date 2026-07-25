import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAdapter } from "../../src/harness/claude.mjs";
import { verifyHarness, loadVerificationRecord } from "../../src/harness/verify.mjs";

test("verifyHarness records version-keyed status from injectable runner", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-verify-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  const record = await verifyHarness({
    adapter: claudeAdapter,
    fixtureProject: "/tmp/fixture",
    env,
    now: "2026-07-25T12:00:00Z",
    runner: Object.assign(
      async () => ({ native_shell: "denied", broker_tool: "passed" }),
      {
        execFileSync: () => "claude 1.2.3\n",
      }
    ),
  });
  assert.equal(record.status, "verified");
  assert.equal(record.cli_version, "1.2.3");
  assert.equal(loadVerificationRecord("claude", "1.2.3", env).status, "verified");

  const failed = await verifyHarness({
    adapter: {
      ...claudeAdapter,
      version: () => "9.9.9",
    },
    fixtureProject: "/tmp/fixture",
    env,
    runner: Object.assign(
      async () => ({ native_shell: "allowed", broker_tool: "failed" }),
      { execFileSync: () => "9.9.9" }
    ),
  });
  assert.equal(failed.status, "failed");
  fs.rmSync(home, { recursive: true, force: true });
});
