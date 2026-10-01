import test from "node:test";
import assert from "node:assert/strict";
import { applyRoleEdit, applySettingsEdit, buildRolesView, modelLabel } from "../../src/dashboard/roles.mjs";

const roster = {
  clis: { claude: { cmd: ["claude"] }, codex: { cmd: ["codex"] } },
  accounts: { claude: { kind: "subscription", enabled: true }, api: { kind: "credit", enabled: true, remaining: 1 } },
  models: {
    "claude-opus": { cli: ["claude"], cli_model: "opus", account: "claude" },
    "gpt-6-sol": { cli: ["codex"] },
  },
  roles: { planner: { chain: ["claude:claude-opus"] }, implementer: { chain: ["codex:gpt-6-sol"] } },
  triage: { roles: ["implementer"] },
};
const store = { clis: { claude: { supported: true, models: [{ cli_id: "opus", version: "Opus 5.5" }] } } };

test("an alias shows the version its CLI resolves it to", () => {
  assert.equal(modelLabel(roster, store, "claude-opus"), "claude-opus-5.5");
  assert.equal(modelLabel(roster, store, "gpt-6-sol"), "gpt-6-sol");
  assert.equal(modelLabel(roster, {}, "claude-opus"), "claude-opus");
});

test("saving a chain creates the role and pins its head", () => {
  const next = applyRoleEdit(roster, {
    role: "scout", chain: [{ cli: "claude", model: "claude-opus" }, { cli: "codex", model: "gpt-6-sol", effort: "high" }],
  });
  assert.deepEqual(next.roles.scout, {
    chain: ["claude:claude-opus", { model: "gpt-6-sol", cli: "codex", effort: "high" }], pin_head: true,
  });
  assert.equal(roster.roles.scout, undefined, "input untouched");
});

test("a chain naming a model on the wrong CLI is refused", () => {
  assert.throws(() => applyRoleEdit(roster, { role: "x", chain: [{ cli: "codex", model: "claude-opus" }] }), /does not run on codex/);
  assert.throws(() => applyRoleEdit(roster, { role: "x", chain: [] }), /at least one/);
  assert.throws(() => applyRoleEdit(roster, { role: "Bad Name", chain: [{ cli: "codex", model: "gpt-6-sol" }] }), /role name/);
});

test("delete is refused while triage routes to the role", () => {
  assert.throws(() => applyRoleEdit(roster, { role: "implementer", delete: true }), /triage.roles/);
  assert.equal(applyRoleEdit(roster, { role: "planner", delete: true }).roles.planner, undefined);
});

test("settings: only whitelisted paths, typed", () => {
  assert.equal(applySettingsEdit(roster, { path: "accounts.claude.enabled", value: false }).accounts.claude.enabled, false);
  assert.equal(applySettingsEdit(roster, { path: "limits.warn_at", value: 0.8 }).limits.warn_at, 0.8);
  assert.throws(() => applySettingsEdit(roster, { path: "clis.claude.cmd", value: ["sh"] }), /not editable/);
  assert.throws(() => applySettingsEdit(roster, { path: "accounts.nope.enabled", value: true }), /invalid/);
  assert.throws(() => applySettingsEdit(roster, { path: "triage.roles", value: ["ghost"] }), /invalid/);
  assert.throws(() => applySettingsEdit(roster, { path: "accounts.claude.remaining", value: 3 }), /invalid/);
});

test("roles view carries pick, chain state and labels", () => {
  const view = buildRolesView(roster, {}, store, Date.parse("2026-10-01T00:00:00Z"));
  const planner = view.roles.find((r) => r.role === "planner");
  assert.equal(planner.chain[0].label, "claude-opus-5.5");
  assert.equal(planner.chain[0].state, "ok");
  assert.equal(view.roles.find((r) => r.role === "implementer").in_triage, true);
});
