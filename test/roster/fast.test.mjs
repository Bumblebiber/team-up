import test from "node:test";
import assert from "node:assert/strict";
import { buildCommand } from "../../src/roster/command.mjs";
import { fastSupported } from "../../src/roster/config.mjs";
import { pick } from "../../src/roster/chain.mjs";

const roster = {
  clis: {
    codex: { cmd: ["codex", "-c", "model_reasoning_effort={effort}", "--model", "{model}", "{prompt}"] },
    cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] },
    opencode: { cmd: ["opencode", "--model", "{model}", "{prompt}"] },
  },
  models: {
    sol: { cli: ["codex"] },
    grok: { cli: ["cursor"], cli_model: "grok-4.7-{effort}", efforts: ["high"] },
    composer: { cli: ["cursor"], cli_model: "composer-2.5" },
    plain: { cli: ["cursor"] },
    oc: { cli: ["opencode"] },
  },
  roles: { r: { chain: [{ cli: "codex", model: "sol", fast: true }] } },
};
const store = { clis: { cursor: { models: [{ cli_id: "grok-4.7-high-fast" }, { cli_id: "composer-2.5-fast" }] } } };

test("codex fast adds the priority service tier before the prompt", () => {
  const argv = buildCommand({ roster, model: "sol", cli: "codex", prompt: "P", effort: "high", fast: true });
  assert.deepEqual(argv.slice(-3), ["-c", 'service_tier="priority"', "P"]);
  assert.ok(!buildCommand({ roster, model: "sol", cli: "codex", prompt: "P" }).some((a) => a.includes("service_tier")));
});

test("cursor fast uses the scanned -fast id, else runs without fast", () => {
  assert.ok(buildCommand({ roster, model: "grok", cli: "cursor", prompt: "P", effort: "high", fast: true, store }).includes("grok-4.7-high-fast"));
  assert.ok(buildCommand({ roster, model: "composer", cli: "cursor", prompt: "P", fast: true, store }).includes("composer-2.5-fast"));
  assert.ok(buildCommand({ roster, model: "plain", cli: "cursor", prompt: "P", fast: true, store }).includes("plain"));
  assert.ok(buildCommand({ roster, model: "oc", cli: "opencode", prompt: "P", fast: true, store }).includes("oc"));
});

test("fastSupported: codex always, cursor only with a scanned twin, others never", () => {
  assert.equal(fastSupported(roster, store, "sol", "codex"), true);
  assert.equal(fastSupported(roster, store, "grok", "cursor"), true);
  assert.equal(fastSupported(roster, store, "composer", "cursor"), true);
  assert.equal(fastSupported(roster, store, "plain", "cursor"), false);
  assert.equal(fastSupported(roster, store, "oc", "opencode"), false);
});

test("pick carries the chain entry's fast", () => {
  assert.equal(pick({ roster, usage: {}, role: "r" }).fast, true);
});

test("codex fast follows codex's own model cache when it is readable", () => {
  assert.equal(fastSupported(roster, store, "sol", "codex", new Set(["sol"])), true);
  assert.equal(fastSupported(roster, store, "sol", "codex", new Set(["other"])), false);
});
