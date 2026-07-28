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

test("buildExpectScript uses result marker for cursor after command", () => {
  const script = buildExpectScript("cursor");
  const cmdIdx = script.indexOf('send "/usage\\r"');
  const includedIdx = script.lastIndexOf('-re "Included"');
  assert.ok(cmdIdx < includedIdx, "cursor sends /usage before waiting for Included");
});
