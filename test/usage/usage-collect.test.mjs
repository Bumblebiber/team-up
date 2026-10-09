import { test } from "node:test";
import assert from "node:assert/strict";
import { isSubscriptionCli } from "../../src/usage/usage-collect.mjs";

test("isSubscriptionCli rejects non-subscription clis like hermes", () => {
  const roster = { subscriptions: ["claude", "codex", "cursor"] };
  assert.equal(isSubscriptionCli("hermes", roster), false);
  assert.equal(isSubscriptionCli("codex", roster), true);
});

test("agy JSON collector writes subscription windows and never falls back to PTY", async () => {
  const { collectUsageForCli } = await import("../../src/usage/usage-collect.mjs");
  const fixture = JSON.parse(await (await import("node:fs/promises")).readFile(
    new URL("./fixtures/usage/agy-usage.json", import.meta.url), "utf8",
  ));
  let written;
  let args;
  const result = await collectUsageForCli({
    cli: "agy",
    roster: { subscriptions: ["agy"] },
    now: Date.parse("2026-10-09T08:13:46Z"),
    runAgy: (bin, argv) => { args = [bin, ...argv]; return JSON.stringify(fixture); },
    readUsage: () => ({ windows: {}, marked: {} }),
    writeUsage: (doc) => { written = doc; },
    collectFallback: async () => assert.fail("agy must not use the PTY fallback"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(args, ["agy", "-p", "/usage", "--output-format", "json"]);
  assert.deepEqual(Object.keys(written.windows).sort(), [
    "agy:3p-5h", "agy:3p-weekly", "agy:gemini-5h", "agy:gemini-weekly",
  ]);
});

test("agy collection failure stays on JSON path", async () => {
  const { collectUsageForCli } = await import("../../src/usage/usage-collect.mjs");
  const result = await collectUsageForCli({
    cli: "agy",
    roster: { subscriptions: ["agy"] },
    runAgy: () => { throw new Error("not logged in"); },
    collectFallback: async () => assert.fail("agy has no PTY fallback"),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /agy \/usage command failed/);
});

test("loggedOut reads each CLI's own status command, logged in or not", async () => {
  const { loggedOut } = await import("../../src/usage/usage-collect.mjs");
  const reply = (stdout, stderr = "") => () => ({ stdout, stderr });
  // Real outputs: claude 2.1.286, codex-cli 0.157.0, cursor-agent 2026.10.01.
  assert.equal(loggedOut("claude", reply('{\n  "loggedIn": false,\n  "authMethod": "none"\n}')), true);
  assert.equal(loggedOut("claude", reply('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}')), false);
  assert.equal(loggedOut("codex", reply("", "WARNING: proceeding …\nNot logged in\n")), true);
  assert.equal(loggedOut("codex", reply("Logged in using ChatGPT\n")), false);
  assert.equal(loggedOut("cursor", reply("Not logged in\n")), true);
  assert.equal(loggedOut("cursor", reply("✓ Logged in as someone@example.com\n")), false);
  // A status command that cannot run says nothing about the login.
  assert.equal(loggedOut("cursor", () => ({ error: new Error("ENOENT") })), false);
  assert.equal(loggedOut("hermes", reply("Not logged in")), false);
});
