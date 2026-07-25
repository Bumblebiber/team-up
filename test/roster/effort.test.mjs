import test from "node:test";
import assert from "node:assert/strict";
import { parseChainEntry, resolveEffort } from "../../src/roster/chain.mjs";
import { buildCommand } from "../../src/roster/command.mjs";

test("effort precedence is cell then role then model", () => {
  const roster = {
    models: { m: { effort: "high" } },
    roles: { r: { effort: "medium" } }
  };
  assert.equal(resolveEffort({ roster, role: "r", model: "m", cellEffort: "max" }), "max");
  assert.equal(resolveEffort({ roster, role: "r", model: "m" }), "medium");
});

test("unset effort removes flag and value", () => {
  const roster = { clis: { codex: { cmd: ["codex", "-c", "model_reasoning_effort={effort}", "{prompt}"] } } };
  assert.deepEqual(buildCommand({ roster, cli: "codex", model: "m", prompt: "p" }), ["codex", "p"]);
});

test("object chain cell carries effort", () => {
  assert.deepEqual(parseChainEntry({ cli: "cursor", model: "m", effort: "high" }),
    { cli: "cursor", model: "m", effort: "high" });
});
