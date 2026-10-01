import test from "node:test";
import assert from "node:assert/strict";
import { buildCatalogueView, applyCatalogueToggle } from "../../src/dashboard/catalogue.mjs";
import { addOfferedVersions } from "../../src/roster/latest.mjs";

const scan = (ids) => ({ supported: true, scanned_at: new Date().toISOString(), models: ids.map((cli_id) => ({ cli_id })) });
const store = {
  clis: {
    claude: scan(["opus", "sonnet"]),
    codex: scan(["gpt-6-sol", "gpt-6-luna", "gpt-7-sol"]),
    cursor: scan(["cursor-grok-4.5-high", "glm-5.2-high"]),
    opencode: scan(["opencode/big-pickle", "openrouter/x-ai/grok-4.5", "openrouter/z-ai/glm-5", "minimax/MiniMax-M3"]),
  },
};
const roster = {
  clis: { claude: {}, codex: {}, cursor: {}, opencode: {}, hermes: {} },
  accounts: {
    claude: { kind: "subscription", enabled: true },
    codex: { kind: "subscription", enabled: true },
    cursor: { kind: "subscription", enabled: true },
    api: { kind: "credit", enabled: true },
    moonshot: { kind: "credit", enabled: false },
  },
  models: {
    "claude-opus": { cli: ["claude"], cli_model: "opus", account: "claude", tier: "frontier" },
    "gpt-6-sol": { cli: ["codex"], account: "codex", tier: "frontier", reasoning: { max: "max" } },
    "grok-4.5-high": { provider: "xai", cli: ["cursor", "opencode", "hermes"], account: "cursor",
      cli_model: { cursor: "cursor-grok-4.5-high", opencode: "openrouter/x-ai/grok-4.5" } },
    "deepseek-v4-pro": { provider: "deepseek", cli: ["hermes"], account: "api" },
    "kimi-k2": { provider: "moonshotai", cli: ["hermes"], account: "moonshot" },
    "openrouter/z-ai/glm-5": { provider: "openrouter", cli: ["opencode"], account: "api", tier: "medium" },
  },
  roles: {
    planner: { chain: ["claude:claude-opus", "codex:gpt-6-sol"] },
    solo: { chain: ["codex:gpt-6-sol"] },
  },
};

const rows = (view) => view.providers.flatMap((p) => p.models.map((m) => ({ ...m, tab: p.tab, provider: p.id })));

test("every roster (model, cli) shows up checked, grouped by who bills it", () => {
  const view = buildCatalogueView(roster, store);
  const checked = rows(view).filter((r) => r.checked);
  for (const [id, spec] of Object.entries(roster.models)) {
    for (const cli of spec.cli) {
      assert.ok(checked.some((r) => r.cli === cli && r.roster_ids.includes(id)), `${id} on ${cli}`);
    }
  }
  const tabs = Object.fromEntries(view.providers.map((p) => [p.id, p.tab]));
  assert.deepEqual(tabs, { claude: "subscription", codex: "subscription", cursor: "subscription",
    openrouter: "api", minimax: "api", deepseek: "api", moonshotai: "api" });
  assert.ok(!rows(view).some((r) => r.cli_id.startsWith("opencode/")), "opencode's own tier is not a provider");
  assert.equal(rows(view).find((r) => r.cli_id === "gpt-6-luna").checked, false);
});

test("checking adds a model like its sibling; unchecking keeps that id out", () => {
  const on = applyCatalogueToggle(roster, { cli: "codex", cli_id: "gpt-6-luna", on: true });
  assert.deepEqual(on.models["gpt-6-luna"], { provider: "codex", account: "codex", cli: ["codex"] });
  const sol = applyCatalogueToggle(roster, { cli: "codex", cli_id: "gpt-7-sol", on: true });
  assert.deepEqual(sol.models["gpt-7-sol"], { tier: "frontier", reasoning: { max: "max" }, provider: "codex", account: "codex", cli: ["codex"] });

  const off = applyCatalogueToggle(on, { cli: "codex", cli_id: "gpt-6-luna", on: false });
  assert.equal(off.models["gpt-6-luna"], undefined);
  assert.deepEqual(off.models_excluded, ["codex:gpt-6-luna"]);
  // gpt-7-sol is a newer gpt-sol: offered and added, unless excluded.
  assert.deepEqual(addOfferedVersions(off, store).added.map((a) => a.id), ["gpt-7-sol"]);
  const ex = { ...off, models_excluded: ["codex:gpt-6-luna", "codex:gpt-7-sol"] };
  assert.deepEqual(addOfferedVersions(ex, store).added, []);
  // Checking again lifts the exclusion.
  assert.equal(applyCatalogueToggle(off, { cli: "codex", cli_id: "gpt-6-luna", on: true }).models_excluded, undefined);
});

test("only a roster CLI and an id its scan lists can be checked in", () => {
  assert.throws(() => applyCatalogueToggle(roster, { cli: "__proto__", cli_id: "x", on: true }), /roster cli/);
  assert.throws(() => applyCatalogueToggle(roster, { cli: "codex", cli_id: "gpt-9-made-up", on: true }, store), /does not offer/);
  assert.ok(applyCatalogueToggle(roster, { cli: "codex", cli_id: "gpt-6-luna", on: true }, store).models["gpt-6-luna"]);
});

test("a checked API model gets its newer version auto-added", () => {
  const s = { clis: { opencode: scan(["openrouter/z-ai/glm-5", "openrouter/z-ai/glm-5.3"]) } };
  assert.deepEqual(addOfferedVersions(roster, s).added.map((a) => a.id), ["openrouter/z-ai/glm-5.3"]);
});

test("unchecking a CLI of a multi-CLI model keeps the model on the others", () => {
  const next = applyCatalogueToggle(roster, { cli: "opencode", cli_id: "openrouter/x-ai/grok-4.5", on: false });
  assert.deepEqual(next.models["grok-4.5-high"].cli, ["cursor", "hermes"]);
});

test("unchecking a model in a chain asks first, then replaces or strikes it", () => {
  assert.throws(() => applyCatalogueToggle(roster, { cli: "claude", cli_id: "opus", on: false }),
    (e) => assert.deepEqual(e.roles, ["planner"]) ?? true);
  const replaced = applyCatalogueToggle(roster, { cli: "claude", cli_id: "opus", on: false,
    resolve: { model: "gpt-6-sol", cli: "codex" } });
  assert.deepEqual(replaced.roles.planner.chain, ["codex:gpt-6-sol"]);
  assert.equal(replaced.models["claude-opus"], undefined);
  const struck = applyCatalogueToggle(roster, { cli: "claude", cli_id: "opus", on: false, resolve: "strike" });
  assert.deepEqual(struck.roles.planner.chain, ["codex:gpt-6-sol"]);
  assert.throws(() => applyCatalogueToggle(roster, { cli: "codex", cli_id: "gpt-6-sol", on: false, resolve: "strike" }),
    /chain of solo would be empty/);
});
