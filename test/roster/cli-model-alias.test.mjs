import { test } from "node:test";
import assert from "node:assert/strict";
import { cliModelFor, cliModelAliases } from "../../src/roster/config.mjs";
import { buildCommand } from "../../src/roster/command.mjs";

const ROSTER = {
  clis: {
    cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] },
    opencode: { cmd: ["opencode", "run", "--model", "{model}", "{prompt}"] },
    hermes: { cmd: ["hermes", "chat", "--model", "{model}", "-q", "{prompt}"] },
  },
  models: {
    // One model, three CLIs, three spellings — the case a single alias cannot serve.
    "grok-4.5-high": {
      cli: ["cursor", "opencode", "hermes"],
      cli_model: { cursor: "cursor-grok-4.5-high", opencode: "openrouter/x-ai/grok-4.5" },
    },
    "claude-opus": { cli: ["claude"], cli_model: "opus" },
    plain: { cli: ["cursor"] },
  },
};

test("a per-CLI map resolves each CLI to its own id", () => {
  assert.equal(cliModelFor(ROSTER, "grok-4.5-high", "cursor"), "cursor-grok-4.5-high");
  assert.equal(cliModelFor(ROSTER, "grok-4.5-high", "opencode"), "openrouter/x-ai/grok-4.5");
});

test("a CLI the map omits falls back to the roster id, not to another CLI's alias", () => {
  assert.equal(cliModelFor(ROSTER, "grok-4.5-high", "hermes"), "grok-4.5-high");
});

test("a plain string alias still applies to every cli", () => {
  assert.equal(cliModelFor(ROSTER, "claude-opus", "claude"), "opus");
  assert.equal(cliModelFor(ROSTER, "claude-opus", "anything"), "opus");
});

test("no alias means the roster id", () => {
  assert.equal(cliModelFor(ROSTER, "plain", "cursor"), "plain");
  assert.equal(cliModelFor(ROSTER, "not-a-model", "cursor"), "not-a-model");
});

test("buildCommand substitutes the alias for the cli it is spawning", () => {
  const cursor = buildCommand({ roster: ROSTER, model: "grok-4.5-high", cli: "cursor", prompt: "hi" });
  assert.deepEqual(cursor, ["cursor-agent", "--model", "cursor-grok-4.5-high", "hi"]);
  const opencode = buildCommand({ roster: ROSTER, model: "grok-4.5-high", cli: "opencode", prompt: "hi" });
  assert.deepEqual(opencode, ["opencode", "run", "--model", "openrouter/x-ai/grok-4.5", "hi"]);
});

test("cliModelAliases lists every spelling a model answers to", () => {
  assert.deepEqual(
    cliModelAliases(ROSTER.models["grok-4.5-high"], "grok-4.5-high").sort(),
    ["cursor-grok-4.5-high", "openrouter/x-ai/grok-4.5"]
  );
  assert.deepEqual(cliModelAliases(ROSTER.models["claude-opus"], "claude-opus"), ["opus"]);
  assert.deepEqual(cliModelAliases(ROSTER.models.plain, "plain"), ["plain"]);
});
