import test from "node:test";
import assert from "node:assert/strict";
import { validateRoster } from "../../src/roster/config.mjs";
import { buildCommand } from "../../src/roster/command.mjs";

const ROSTER = {
  clis: {
    codex: {
      cmd: ["codex", "--model", "{model}", "{prompt}"],
      headless_cmd: [
        "codex", "exec", "-c", "model_reasoning_effort={effort}", "--model", "{model}",
        "--json", "-o", "{last_message}", "{prompt}",
      ],
    },
  },
  models: { "gpt-5.6-sol": { cli_model: "gpt-5.6-sol" } },
};

test("buildCommand selects headless template and fills its placeholders", () => {
  assert.deepEqual(buildCommand({
    roster: ROSTER,
    model: "gpt-5.6-sol",
    cli: "codex",
    prompt: "do work",
    effort: "high",
    headless: true,
    lastMessage: "/tmp/run/mailbox/LAST_MESSAGE.md",
  }), [
    "codex", "exec", "-c", "model_reasoning_effort=high", "--model", "gpt-5.6-sol",
    "--json", "-o", "/tmp/run/mailbox/LAST_MESSAGE.md", "do work",
  ]);
});

test("buildCommand keeps interactive cmd when headless is off", () => {
  assert.deepEqual(buildCommand({
    roster: { clis: { codex: { cmd: ["codex", "--model", "{model}", "{prompt}"] } } },
    model: "m",
    cli: "codex",
    prompt: "p",
  }), ["codex", "--model", "m", "p"]);
});

test("validateRoster requires headless_cmd to be an array of strings", () => {
  assert.ok(validateRoster({ clis: { codex: { headless_cmd: "codex exec" } } })
    .errors.some((error) => error.includes("clis.codex.headless_cmd")));
  assert.deepEqual(validateRoster(ROSTER).errors, []);
});

test("validateRoster rejects headless_cmd outside codex and cursor", () => {
  assert.ok(validateRoster({ clis: { hermes: { cmd: ["hermes"], headless_cmd: ["hermes"] } } })
    .errors.includes("clis.hermes.headless_cmd is only supported for codex and cursor"));
});
