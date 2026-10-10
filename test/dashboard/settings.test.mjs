import test from "node:test";
import assert from "node:assert/strict";
import { validateRoster } from "../../src/roster/config.mjs";
import { admissionConfig } from "../../src/admission/admission.mjs";
import { telemetryConfig } from "../../src/telemetry/config.mjs";
import { watcherConfig } from "../../src/usage/usage-watcher.mjs";
import { applySettingsEdit, buildSettingsView, settingsFields, GROUPS } from "../../src/dashboard/settings.mjs";

const roster = {
  clis: { claude: { cmd: ["claude"] }, codex: { cmd: ["codex"] }, cursor: { cmd: ["cursor-agent"] } },
  accounts: {
    claude: { kind: "subscription", enabled: true },
    api: { kind: "credit", enabled: true, remaining: 1 },
  },
  models: {
    "claude-opus": { cli: ["claude"], account: "claude" },
    "claude-sonnet": { cli: ["claude"], account: "claude" },
    "gpt-6-sol": { cli: ["codex"] },
  },
  subscriptions: ["claude", "codex"],
  roles: { planner: { chain: ["claude:claude-opus"] } },
};

const field = (r, path) => settingsFields(r).find((f) => f.path === path);

test("every field belongs to a known group and carries label, type and help or a default", () => {
  const groups = new Set(GROUPS.map((g) => g.id));
  for (const f of settingsFields(roster)) {
    assert.ok(groups.has(f.group), `${f.path}: group ${f.group}`);
    assert.ok(f.label && f.type && f.effect, `${f.path}: label/type/effect`);
  }
  const view = buildSettingsView(roster);
  assert.ok(view.excluded.some((e) => /clis\.\*\.cmd/.test(e.what)), "exclusions say why cmd is not here");
});

test("only listed paths are writable — command templates never", () => {
  assert.throws(() => applySettingsEdit(roster, { path: "clis.claude.cmd", value: ["sh"] }), /not editable/);
  assert.throws(() => applySettingsEdit(roster, { path: "openrouter.key_file", value: "/etc/shadow" }), /not editable/);
  assert.throws(() => applySettingsEdit(roster, { path: "accounts.nope.enabled", value: true }), /not editable/);
  assert.throws(() => applySettingsEdit(roster, { path: "accounts.__proto__.enabled", value: true }), /not editable/);
  assert.throws(() => applySettingsEdit(roster, { path: "accounts.claude.remaining", value: 3 }), /not editable/, "subscription has no credit");
  assert.throws(() => applySettingsEdit(roster, { path: "accounts.api.plan", value: "pro" }), /not editable/, "credit has no plan");
});

test("values are typed and bounded", () => {
  assert.equal(applySettingsEdit(roster, { path: "accounts.claude.enabled", value: false }).accounts.claude.enabled, false);
  assert.equal(applySettingsEdit(roster, { path: "limits.warn_at", value: 0.8 }).limits.warn_at, 0.8);
  assert.throws(() => applySettingsEdit(roster, { path: "limits.warn_at", value: 1.5 }), /at most 1/);
  assert.throws(() => applySettingsEdit(roster, { path: "limits.warn_at", value: 0 }), /above 0/);
  assert.throws(() => applySettingsEdit(roster, { path: "admission.fallback_max_workers", value: 2.5 }), /whole number/);
  assert.throws(() => applySettingsEdit(roster, { path: "accounts.claude.enabled", value: "yes" }), /on or off/);
  assert.throws(() => applySettingsEdit(roster, { path: "accounts.claude.plan", value: "ultra" }), /not one of the choices/);
  assert.equal(applySettingsEdit(roster, { path: "accounts.claude.plan", value: "max20x" }).accounts.claude.plan, "max20x");
  assert.equal(roster.limits, undefined, "input untouched");
});

test("subscriptions: known CLIs only, never empty", () => {
  assert.throws(() => applySettingsEdit(roster, { path: "subscriptions", value: ["ghost"] }), /unknown choice/);
  assert.throws(() => applySettingsEdit(roster, { path: "subscriptions", value: [] }), /at least 1/);
  assert.throws(() => applySettingsEdit(roster, { path: "subscriptions", value: ["claude", "claude"] }), /twice/);
  assert.deepEqual(applySettingsEdit(roster, { path: "subscriptions", value: ["cursor"] }).subscriptions, ["cursor"]);
});

test("spender knobs: subscriptions may be empty (spender off), hours are 0-23, model per watched cli", () => {
  assert.deepEqual(field(roster, "usage_spender.subscriptions").default, ["claude", "codex", "cursor"]);
  assert.deepEqual(applySettingsEdit(roster, { path: "usage_spender.subscriptions", value: [] }).usage_spender.subscriptions, []);
  assert.throws(() => applySettingsEdit(roster, { path: "usage_spender.subscriptions", value: ["cursor"] }), /unknown choice/,
    "only watched subscriptions can be spent");
  assert.deepEqual(applySettingsEdit(roster, { path: "usage_spender.spawn_hours", value: [22, 23] }).usage_spender.spawn_hours, [22, 23]);
  assert.throws(() => applySettingsEdit(roster, { path: "usage_spender.spawn_hours", value: [24] }), /unknown choice/);
  const m = field(roster, "usage_spender.implement_model.claude");
  assert.equal(m.default, "claude:claude-sonnet");
  assert.deepEqual(m.options.map((o) => o.value), ["", "claude:claude-opus", "claude:claude-sonnet"]);
  assert.equal(applySettingsEdit(roster, { path: "usage_spender.implement_model.claude", value: "" })
    .usage_spender.implement_model.claude, "");
  assert.throws(() => applySettingsEdit(roster, { path: "usage_spender.implement_model.claude", value: "codex:gpt-6-sol" }), /choices/);
});

test("reset removes the key, prunes emptied parents, and the code default applies again", () => {
  const set = applySettingsEdit(roster, { path: "usage_watcher.cli_intervals.codex.idle_min", value: 45 });
  assert.equal(watcherConfig(set).cli_intervals.codex.idle_min, 45);
  const back = applySettingsEdit(set, { path: "usage_watcher.cli_intervals.codex.idle_min", reset: true });
  assert.equal(back.usage_watcher, undefined, "emptied objects are pruned");
  assert.equal(watcherConfig(back).cli_intervals.codex.idle_min, 30);
  assert.throws(() => applySettingsEdit(roster, { path: "accounts.claude.enabled", reset: true }), /no default/);
});

test("null on a nullable field means its default: auto workers, plan not set", () => {
  const capped = applySettingsEdit(roster, { path: "admission.max_workers", value: 3 });
  assert.equal(admissionConfig({}, { roster: capped }).max_workers, 3);
  const auto = applySettingsEdit(capped, { path: "admission.max_workers", value: null });
  assert.equal(auto.admission, undefined);
  assert.equal(admissionConfig({}, { roster: auto }).max_workers, null);
});

test("whatever the registry accepts, the readers and the roster validator accept too", () => {
  let r = roster;
  for (const f of settingsFields(roster)) {
    let value;
    if (f.type === "bool") value = !(f.value ?? f.default);
    else if (f.type === "ratio") value = 0.5;
    else if (f.type === "int" || f.type === "number") value = Math.max(f.min ?? 1, 1);
    else if (f.type === "enum") value = f.options.at(-1).value;
    else if (f.type === "set") value = f.options.map((o) => o.value);
    r = applySettingsEdit(r, { path: f.path, value });
  }
  assert.deepEqual(validateRoster(r).errors, []);
  admissionConfig({}, { roster: r });
  telemetryConfig({}, { roster: r });
  watcherConfig(r);
});
