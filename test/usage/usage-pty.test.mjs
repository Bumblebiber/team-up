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

test("buildExpectScript cursor slow-types /usage, waits for autocomplete accept, then the panel", () => {
  const script = buildExpectScript("cursor", 180);
  const tipIdx = script.indexOf('-re "Tip:"');
  const slashIdx = script.indexOf('send "/"');
  const usageIdx = script.indexOf('send "usage"');
  const acceptIdx = script.indexOf('-re "Show plan"');
  // "Esc to close" is the panel's last line. Waiting on "Included" — its first
  // row — could return before Auto and API had rendered beneath it.
  const panelIdx = script.lastIndexOf('-re "Esc to close"');
  const sttyIdx = script.indexOf("stty cols 120 rows 40");
  assert.ok(sttyIdx >= 0, "sets terminal size");
  assert.ok(tipIdx >= 0, "waits for Tip readiness");
  assert.ok(slashIdx >= 0 && usageIdx > slashIdx, "slow-types /usage");
  assert.ok(acceptIdx > usageIdx, "waits for slash autocomplete");
  assert.ok(panelIdx > acceptIdx, "waits for the rendered panel after the command runs");
});

test("buildExpectScript cursor waits for the panel instead of sleeping a fixed span", () => {
  const script = buildExpectScript("cursor", 180);
  const enterIdx = script.lastIndexOf('send "\\r"');
  const tail = script.slice(enterIdx);
  // A blind `sleep 36` after Enter pushed one collect past two and a half
  // minutes, over the watcher's ceiling, so every cursor collect died on
  // ETIMEDOUT. Nothing after the command may wait longer than a beat.
  for (const [, secs] of tail.matchAll(/sleep (\d+(?:\.\d+)?)/g)) {
    assert.ok(Number(secs) <= 3, `blind sleep of ${secs}s after the command`);
  }
});

test("codex boot dismisses the update dialog with escape, never the menu", () => {
  const script = buildExpectScript("codex", 180);
  assert.match(script, /-re "Update available" \{ sleep 2; send "\\033"; exp_continue \}/);
  // Option 1 of that dialog shells out to the codex installer.
  assert.equal(/Update available.*send "1/.test(script), false);
});
