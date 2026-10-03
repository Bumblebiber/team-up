import { test } from "node:test";
import assert from "node:assert/strict";
import { isSubscriptionCli } from "../../src/usage/usage-collect.mjs";

test("isSubscriptionCli rejects non-subscription clis like hermes", () => {
  const roster = { subscriptions: ["claude", "codex", "cursor"] };
  assert.equal(isSubscriptionCli("hermes", roster), false);
  assert.equal(isSubscriptionCli("codex", roster), true);
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
