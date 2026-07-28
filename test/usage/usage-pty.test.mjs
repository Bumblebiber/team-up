import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExpectScript } from "../../src/usage/usage-pty.mjs";

test("buildExpectScript codex waits for Tip, uses sized PTY from HOME, sleeps after /status", () => {
  const script = buildExpectScript("codex", 180);
  const tipIdx = script.indexOf('-re "Tip:"');
  const cmdIdx = script.indexOf('send "/status\\r"');
  const sleepIdx = script.indexOf("sleep 27");
  const homeIdx = script.indexOf(process.env.HOME || "/home/");
  const sttyIdx = script.indexOf("stty cols 120 rows 40");
  assert.ok(tipIdx >= 0, "waits for Tip readiness");
  assert.ok(homeIdx >= 0, "spawns from HOME");
  assert.ok(sttyIdx >= 0, "sets terminal size");
  assert.ok(cmdIdx >= 0, "sends /status");
  assert.ok(sleepIdx > cmdIdx, "sleeps after /status for MCP + panel render");
  assert.ok(tipIdx < cmdIdx, "readiness before command");
});

test("buildExpectScript cursor slow-types /usage, waits for autocomplete accept, then Included", () => {
  const script = buildExpectScript("cursor", 180);
  const tipIdx = script.indexOf('-re "Tip:"');
  const slashIdx = script.indexOf('send "/"');
  const usageIdx = script.indexOf('send "usage"');
  const acceptIdx = script.indexOf('-re "Show plan"');
  const includedIdx = script.lastIndexOf('-re "Included"');
  const sttyIdx = script.indexOf("stty cols 120 rows 40");
  assert.ok(sttyIdx >= 0, "sets terminal size");
  assert.ok(tipIdx >= 0, "waits for Tip readiness");
  assert.ok(slashIdx >= 0 && usageIdx > slashIdx, "slow-types /usage");
  assert.ok(acceptIdx > usageIdx, "waits for slash autocomplete");
  assert.ok(includedIdx > acceptIdx, "waits for Included after command runs");
});
