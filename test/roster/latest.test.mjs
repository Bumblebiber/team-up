import test from "node:test";
import assert from "node:assert/strict";
import { splitVersion, cellStatus, upgradeChains, bringToLatest } from "../../src/roster/latest.mjs";

const roster = {
  clis: { codex: { cmd: ["codex"] }, claude: { cmd: ["claude"] } },
  accounts: { codex: { kind: "subscription", enabled: true } },
  models: {
    "gpt-5.6-sol": { cli: ["codex"], account: "codex" },
    "gpt-6-sol": { cli: ["codex"], account: "codex" },
    "gpt-7-sol": { cli: ["codex"], account: "codex" },
    "gpt-5.6-terra": { cli: ["codex"], account: "codex" },
    "claude-opus": { cli: ["claude"], cli_model: "opus" },
  },
  roles: {
    planner: { chain: ["codex:gpt-5.6-sol", "codex:gpt-6-sol", "claude:claude-opus", "codex:gpt-5.6-terra"] },
    pinned: { chain: [{ model: "gpt-5.6-sol", cli: "codex", pinned: true }] },
  },
};
const store = (models, extra = {}) => ({
  clis: { codex: { supported: true, scanned_at: new Date().toISOString(), models: models.map((cli_id) => ({ cli_id })), ...extra } },
});

test("splitVersion separates family and version", () => {
  assert.deepEqual(splitVersion("gpt-5.6-luna-max"), { family: "gpt-luna-max", version: [5, 6] });
  assert.deepEqual(splitVersion("deepseek-v4-pro"), { family: "deepseek-pro", version: [4] });
  assert.deepEqual(splitVersion("claude-opus"), { family: "claude-opus", version: null });
});

test("newest means newest the CLI offers, not newest in the roster", () => {
  const s = store(["gpt-5.6-sol", "gpt-6-sol"]); // gpt-7-sol not shipped
  assert.deepEqual(cellStatus(roster, s, "codex", "gpt-5.6-sol"), { state: "ok", newest: "gpt-6-sol" });
  assert.deepEqual(cellStatus(roster, s, "codex", "gpt-6-sol"), { state: "ok", newest: null });
  assert.deepEqual(cellStatus(roster, s, "codex", "gpt-5.6-terra"), { state: "gone", newest: null });
});

test("upgrade rewrites, dedupes, and leaves pinned and alias entries alone", () => {
  const { next, changes } = upgradeChains(roster, store(["gpt-5.6-sol", "gpt-6-sol"]));
  assert.deepEqual(next.roles.planner.chain, ["codex:gpt-6-sol", "claude:claude-opus", "codex:gpt-5.6-terra"]);
  assert.deepEqual(next.roles.pinned.chain, roster.roles.pinned.chain);
  assert.deepEqual(changes.map((c) => `${c.from}>${c.to}`), ["gpt-5.6-sol>gpt-6-sol"]);
  assert.equal(roster.roles.planner.chain[0], "codex:gpt-5.6-sol", "input untouched");
});

test("a failed or stale scan moves nothing", () => {
  assert.equal(upgradeChains(roster, store(["gpt-6-sol"], { stale_since: "x" })).changes.length, 0);
  assert.equal(upgradeChains(roster, { clis: { codex: { supported: false } } }).changes.length, 0);
});

test("a scan older than two days moves nothing", () => {
  const old = store(["gpt-6-sol"], { scanned_at: "2020-01-01T00:00:00Z" });
  assert.equal(upgradeChains(roster, old).changes.length, 0);
});

test("a newly shipped version joins the roster as a copy of its sibling, then the chains move", () => {
  const withPrice = structuredClone(roster);
  withPrice.models["gpt-7-sol"] = { cli: ["codex"], account: "codex", tier: "frontier", price: { in: 1 } };
  const { next, added, changes } = bringToLatest(withPrice, store(["gpt-6-sol", "gpt-7-sol", "gpt-8-sol", "o9-mini"]));
  assert.deepEqual(added.map((a) => a.id), ["gpt-8-sol"], "7 exists already; o9-mini has no roster family");
  assert.deepEqual(next.models["gpt-8-sol"], { cli: ["codex"], account: "codex", tier: "frontier" });
  assert.ok(changes.some((c) => c.from === "gpt-5.6-sol" && c.to === "gpt-8-sol"));
});
