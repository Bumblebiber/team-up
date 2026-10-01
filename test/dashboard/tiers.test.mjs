import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildTierMatrixView,
  applyModelEdit,
  saveRoster,
  effortValues,
} from "../../src/dashboard/tiers.mjs";

/**
 * The tier table decides which model a specialist can reach at all, because
 * profile resolution never crosses a tier. Editing it from a panel is only
 * safe while every edit is one named field, validated, and backed up.
 */
const roster = Object.freeze({
  accounts: { anthropic: { kind: "subscription", enabled: true } },
  clis: {
    claude: { cmd: ["claude", "{prompt}"] },
    codex: { cmd: ["codex", "{prompt}"] },
    dead: {},
  },
  models: {
    "claude-opus": {
      provider: "anthropic",
      tier: "frontier",
      account: "anthropic",
      cli: ["claude"],
      reasoning: { max: "max", high: "high", medium: "medium", low: "low" },
    },
    "composer-2.5": {
      provider: "cursor",
      tier: "medium",
      account: "anthropic",
      cli: ["codex"],
      reasoning: { max: "high", high: "high", medium: null, low: null },
    },
  },
  roles: {},
});

test("the view carries one row per model, and only CLIs that can run", () => {
  const view = buildTierMatrixView(roster);
  assert.deepEqual(view.tiers, ["frontier", "high", "medium", "low"]);
  assert.deepEqual(view.clis, ["claude", "codex"], "a cli without cmd is not a column");
  assert.deepEqual(view.effort_values, ["high", "low", "max", "medium"]);
  const composer = view.models.find((m) => m.model === "composer-2.5");
  assert.equal(composer.tier, "medium");
  // A step the model does not have reads as null, not as missing — that is
  // the difference the panel has to show.
  assert.equal(composer.reasoning.medium, null);
  assert.equal(composer.reasoning.high, "high");
});

test("an edit changes one field and leaves the roster it was given alone", () => {
  const next = applyModelEdit(roster, { model: "composer-2.5", tier: "high" });
  assert.equal(next.models["composer-2.5"].tier, "high");
  assert.equal(roster.models["composer-2.5"].tier, "medium", "input must not be mutated");
  assert.deepEqual(next.models["composer-2.5"].cli, ["codex"], "nothing else moved");

  const added = applyModelEdit(roster, { model: "claude-opus", cli: "codex", action: "add" });
  assert.deepEqual(added.models["claude-opus"].cli, ["claude", "codex"]);
  const removed = applyModelEdit(added, { model: "claude-opus", cli: "claude", action: "remove" });
  assert.deepEqual(removed.models["claude-opus"].cli, ["codex"]);

  const effort = applyModelEdit(roster, {
    model: "composer-2.5", level: "medium", effort: "high",
  });
  assert.equal(effort.models["composer-2.5"].reasoning.medium, "high");
  // Clearing a step is a real edit: the model has no such gear.
  assert.equal(
    applyModelEdit(roster, { model: "claude-opus", level: "max", effort: null })
      .models["claude-opus"].reasoning.max,
    null
  );
});

test("an edit that would produce an unreachable cell is refused", () => {
  assert.throws(() => applyModelEdit(roster, { model: "nope", tier: "high" }), /unknown model/);
  assert.throws(() => applyModelEdit(roster, { model: "claude-opus", tier: "turbo" }), /unknown tier/);
  assert.throws(
    () => applyModelEdit(roster, { model: "claude-opus", cli: "dead", action: "add" }),
    /unknown cli/
  );
  // The last cli is what makes the model reachable at all.
  assert.throws(
    () => applyModelEdit(roster, { model: "claude-opus", cli: "claude", action: "remove" }),
    /would have no cli left/
  );
  assert.throws(
    () => applyModelEdit(roster, { model: "claude-opus", cli: "codex", action: "toggle" }),
    /unknown action/
  );
  assert.throws(
    () => applyModelEdit(roster, { model: "claude-opus", level: "turbo", effort: "high" }),
    /unknown reasoning level/
  );
  assert.throws(() => applyModelEdit(roster, { model: "claude-opus" }), /names no field/);
});

test("a roster the validator rejects is never written, and a write keeps a backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-tiers-"));
  try {
    const dest = path.join(dir, "roster.json");
    const env = { TEAM_UP_ROSTER: dest };
    fs.writeFileSync(dest, `${JSON.stringify(roster, null, 2)}\n`);

    const broken = structuredClone(roster);
    broken.models = "not an object";
    assert.throws(() => saveRoster(broken, { env }), /roster invalid/);
    assert.deepEqual(JSON.parse(fs.readFileSync(dest, "utf8")), roster, "file untouched");

    const next = applyModelEdit(roster, { model: "composer-2.5", tier: "high" });
    const written = saveRoster(next, { env });
    assert.equal(JSON.parse(fs.readFileSync(dest, "utf8")).models["composer-2.5"].tier, "high");
    assert.deepEqual(JSON.parse(fs.readFileSync(written.backup, "utf8")), roster);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("effortValues offers what the roster actually uses", () => {
  assert.deepEqual(effortValues({ models: {} }), []);
  assert.deepEqual(
    effortValues({ models: { a: { reasoning: { high: "xhigh", low: null } } } }),
    ["xhigh"]
  );
});

test("a specialist tier override carries the reasoning and clears back to the recommendation", async () => {
  const { applySpecialistTier } = await import("../../src/dashboard/tiers.mjs");
  const { resolveProfile } = await import("../../src/roster/profile.mjs");
  const roster = {
    accounts: { codex: { kind: "subscription", enabled: true } },
    clis: { codex: { cmd: ["codex"] } },
    models: { m: { tier: "low", cli: ["codex"], account: "codex", reasoning: { high: "high" } } },
  };
  const set = applySpecialistTier(roster, { id: "rev", tier: "low", reasoning: "high" });
  assert.deepEqual(set.specialists, { rev: { model_profile: { tier: "low", reasoning: "high" } } });
  const r = resolveProfile({ roster: set, profile: { tier: "frontier", reasoning: "high" }, specialistId: "rev",
    harnessCapabilities: () => ({}) });
  assert.equal(r.profile.tier, "low");
  assert.equal(applySpecialistTier(set, { id: "rev", tier: null }).specialists, undefined);
  assert.throws(() => applySpecialistTier(roster, { id: "rev", tier: "huge", reasoning: "high" }), /tier must be/);
});
