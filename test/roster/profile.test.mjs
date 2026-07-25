import test from "node:test";
import assert from "node:assert/strict";
import { resolveProfile } from "../../src/roster/profile.mjs";

const roster = {
  accounts: {
    cursor: { kind: "subscription", enabled: true },
    api: { kind: "credit", enabled: true, remaining: 12 }
  },
  clis: {
    cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] },
    codex: { cmd: ["codex", "--model", "{model}", "-c", "model_reasoning_effort={effort}", "{prompt}"] }
  },
  models: {
    frontier: { tier: "frontier", cli: ["codex"], account: "api", reasoning: { max: "xhigh" }, priority: 1 },
    mediumA: { tier: "medium", cli: ["cursor"], account: "cursor", reasoning: { low: null }, priority: 1 },
    mediumB: { tier: "medium", cli: ["codex"], account: "api", reasoning: { low: "low" }, priority: 2 },
    low: { tier: "low", cli: ["cursor"], account: "cursor", reasoning: { low: null }, priority: 0 }
  }
};

test("returns same-tier cells only", () => {
  const result = resolveProfile({ roster, profile: { tier: "medium", reasoning: "low" }, usage: {} });
  assert.deepEqual(result.chain.map(x => x.model), ["mediumA", "mediumB"]);
  assert.ok(!result.chain.some(x => x.model === "frontier" || x.model === "low"));
});

test("does not upgrade when exact tier is unavailable", () => {
  const result = resolveProfile({ roster, profile: { tier: "high", reasoning: "max" }, usage: {} });
  assert.equal(result.code, "PROFILE_UNAVAILABLE");
  assert.deepEqual(result.chain, []);
});

test("imports mid as medium", () => {
  const r = {
    ...roster,
    models: {
      ...roster.models,
      midA: { tier: "mid", cli: ["cursor"], account: "cursor", reasoning: { low: null }, priority: 1 },
    },
  };
  const result = resolveProfile({ roster: r, profile: { tier: "medium", reasoning: "low" }, usage: {} });
  assert.ok(result.chain.some(x => x.model === "midA"));
});
