import test from "node:test";
import assert from "node:assert/strict";
import { applyRoleEdit, buildRolesView, modelLabel } from "../../src/dashboard/roles.mjs";

const roster = {
  clis: { claude: { cmd: ["claude"] }, codex: { cmd: ["codex"] } },
  accounts: { claude: { kind: "subscription", enabled: true }, api: { kind: "credit", enabled: true, remaining: 1 } },
  models: {
    "claude-opus": { cli: ["claude"], cli_model: "opus", account: "claude" },
    "gpt-6-sol": { cli: ["codex"] },
  },
  roles: { planner: { chain: ["claude:claude-opus"] }, implementer: { chain: ["codex:gpt-6-sol"] } },
  specialists: { "code-writer": { role: "implementer" } },
};
const store = { clis: { claude: { supported: true, scanned_at: "2026-09-30T12:00:00Z", models: [{ cli_id: "opus", version: "Opus 5.5" }] } } };

test("an alias shows the version its CLI resolves it to", () => {
  assert.equal(modelLabel(roster, store, "claude-opus"), "claude-opus-5.5");
  assert.equal(modelLabel(roster, store, "gpt-6-sol"), "gpt-6-sol");
  assert.equal(modelLabel(roster, {}, "claude-opus"), "claude-opus");
});

test("saving a chain creates the role without score-pipeline metadata", () => {
  const next = applyRoleEdit(roster, {
    role: "scout", chain: [{ cli: "claude", model: "claude-opus" }, { cli: "codex", model: "gpt-6-sol", effort: "high" }],
  });
  assert.deepEqual(next.roles.scout, {
    chain: ["claude:claude-opus", { model: "gpt-6-sol", cli: "codex", effort: "high" }],
  });
  assert.equal(roster.roles.scout, undefined, "input untouched");
});

test("a chain naming a model on the wrong CLI is refused", () => {
  assert.throws(() => applyRoleEdit(roster, { role: "x", chain: [{ cli: "codex", model: "claude-opus" }] }), /does not run on codex/);
  assert.throws(() => applyRoleEdit(roster, { role: "x", chain: [] }), /at least one/);
  assert.throws(() => applyRoleEdit(roster, { role: "Bad Name", chain: [{ cli: "codex", model: "gpt-6-sol" }] }), /role name/);
});

test("delete is refused while a specialist runs on the role, or team-up's own code asks for it", () => {
  const r = { ...roster, roles: { ...roster.roles, scout: { chain: ["claude:claude-opus"] }, triage: { chain: ["claude:claude-opus"] } },
    specialists: { "code-writer": { role: "triage" } } };
  assert.throws(() => applyRoleEdit(r, { role: "triage", delete: true }), /code-writer run on triage — reassign them first/);
  assert.throws(() => applyRoleEdit(r, { role: "implementer", delete: true }), /used by the insights job/);
  assert.throws(() => applyRoleEdit(r, { role: "planner", delete: true }), /change its chain instead/);
  assert.equal(applyRoleEdit(r, { role: "scout", delete: true }).roles.scout, undefined);
});

test("a role carries an effort of its own, cleared with null", () => {
  const next = applyRoleEdit(roster, { role: "planner", effort: "high" });
  assert.equal(next.roles.planner.effort, "high");
  assert.deepEqual(next.roles.planner.chain, roster.roles.planner.chain, "chain untouched");
  assert.equal(applyRoleEdit(next, { role: "planner", effort: null }).roles.planner.effort, undefined);
  assert.throws(() => applyRoleEdit(roster, { role: "planner", effort: "turbo" }), /effort must be one of/);
  assert.throws(() => applyRoleEdit(roster, { role: "ghost", effort: "high" }), /unknown role/);
  assert.throws(() => applyRoleEdit(roster, { role: "planner", pin_head: true }), /expected chain, effort or delete/);
});

test("roles view carries pick, chain state and labels", () => {
  const view = buildRolesView(roster, {}, store, Date.parse("2026-10-01T00:00:00Z"));
  const planner = view.roles.find((r) => r.role === "planner");
  assert.equal(planner.chain[0].label, "claude-opus-5.5");
  assert.equal(planner.chain[0].state, "ok");
});

test("prototype keys never resolve as roles or accounts", () => {
  assert.throws(() => applyRoleEdit(roster, { role: "constructor", delete: true }), /unknown role/);
  assert.throws(() => applyRoleEdit(roster, { role: "x", chain: [{ cli: "codex", model: "constructor" }] }), /unknown model/);
  assert.equal(({}).enabled, undefined);
});
