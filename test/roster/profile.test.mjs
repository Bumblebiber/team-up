import test from "node:test";
import assert from "node:assert/strict";
import { resolveProfile, specialistAssignment } from "../../src/roster/profile.mjs";

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
    big: { cli: ["codex"], account: "api", effort: "high" },
    mediumA: { cli: ["cursor"], account: "cursor" },
    mediumB: { cli: ["codex", "cursor"], account: "api" },
    small: { cli: ["cursor"], account: "cursor" }
  },
  roles: {
    implementer: { chain: ["cursor:mediumA", { model: "big", cli: "codex", effort: "xhigh" }], effort: "medium" },
  },
};

test("a specialist on a role runs that role's chain, in order, with its efforts", () => {
  const r = { ...roster, specialists: { "coding.codey": { role: "implementer" } } };
  const result = resolveProfile({ roster: r, specialistId: "coding.codey", usage: {} });
  assert.equal(result.code, "OK");
  assert.deepEqual(result.profile, { role: "implementer" });
  assert.deepEqual(result.chain.map((x) => [x.cli, x.model, x.effort]),
    [["cursor", "mediumA", "medium"], ["codex", "big", "xhigh"]]);
});

test("a specialist with its own chain runs it; a bare model expands to its CLIs", () => {
  const r = { ...roster, specialists: { "review.revan": { chain: ["mediumB", "codex:big"] } } };
  const result = resolveProfile({ roster: r, specialistId: "review.revan", usage: {} });
  assert.deepEqual(result.chain.map((x) => `${x.cli}:${x.model}@${x.effort}`),
    ["codex:mediumB@null", "cursor:mediumB@null", "codex:big@high"]);
});

test("an unassigned specialist does not launch, and says why", () => {
  const result = resolveProfile({ roster, specialistId: "coding.codey", usage: {} });
  assert.equal(result.code, "PROFILE_UNAVAILABLE");
  assert.match(result.skipped[0].reason, /no role or chain assigned to coding\.codey/);
  assert.equal(specialistAssignment(roster, "coding.codey"), null);
});

test("a run stored before roles replaced tiers re-resolves through the current assignment", () => {
  const r = { ...roster, specialists: { "coding.codey": { role: "implementer" } } };
  const result = resolveProfile({
    roster: r, specialistId: "coding.codey", usage: {}, profile: { tier: "frontier", reasoning: "max" },
  });
  assert.deepEqual(result.chain.map((x) => x.model), ["mediumA", "big"]);
});

test("a model override replaces the chain with that one cell, the other gates stay", () => {
  const r = { ...roster, specialists: { "coding.codey": { role: "implementer" } } };
  const overridden = resolveProfile({
    roster: r, specialistId: "coding.codey", usage: {}, override: { model: "small" },
  });
  assert.deepEqual(overridden.chain.map((x) => `${x.cli}:${x.model}`), ["cursor:small"]);

  const wrongCli = resolveProfile({
    roster: r, specialistId: "coding.codey", usage: {}, override: { model: "small", cli: "codex" },
  });
  assert.equal(wrongCli.code, "PROFILE_UNAVAILABLE");
  assert.match(wrongCli.skipped[0].reason, /does not run on codex/);
});

test("a declared but disabled account bars its cells; an undeclared one does not", () => {
  const r = {
    ...roster,
    accounts: { ...roster.accounts, cursor: { kind: "subscription", enabled: false } },
    models: { ...roster.models, loose: { cli: ["codex"], account: "nowhere" } },
    specialists: { x: { chain: ["mediumA", "loose", "codex:mediumB"] } },
  };
  const result = resolveProfile({ roster: r, specialistId: "x", usage: {} });
  assert.deepEqual(result.chain.map((x) => x.model), ["loose", "mediumB"]);
  assert.ok(result.skipped.some((s) => s.model === "mediumA" && s.reason === "account unavailable"));
});

test("a marked-limited model lands in quota_blocked, not the chain", () => {
  const r = { ...roster, specialists: { x: { chain: ["cursor:mediumA", "cursor:small"] } } };
  const usage = { marked: { mediumA: { until: new Date(Date.now() + 3600_000).toISOString() } } };
  const result = resolveProfile({ roster: r, specialistId: "x", usage });
  assert.deepEqual(result.chain.map((x) => x.model), ["small"]);
  assert.deepEqual(result.quota_blocked.map((x) => x.model), ["mediumA"]);
});
