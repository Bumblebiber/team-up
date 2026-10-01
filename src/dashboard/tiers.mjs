import fs from "node:fs";
import { rosterWritePath } from "../paths.mjs";
import { validateRoster } from "../roster/config.mjs";
import { normalizeTier } from "../roster/profile.mjs";
import { modelLabel } from "./roles.mjs";

/**
 * The tier table, and the only place a human edits it by hand.
 *
 * `resolveProfile` never upgrades or downgrades a tier: a specialist that asks
 * for `high` runs on a high cell or not at all. Which model sits in which tier,
 * on which CLI, and how hard it thinks there is therefore the sharpest lever in
 * the roster — and until now it was a JSON file edited by hand, beside a weekly
 * `apply-scores` that rewrites its own part of the same file.
 *
 * Only three fields are editable here, and `applyProposals` touches none of
 * them: it changes `roles[*].chain` and may add a model, never an existing
 * model's tier, cli list or reasoning map. A hand-set table survives the
 * refresh.
 */

export const TIERS = Object.freeze(["frontier", "high", "medium", "low"]);
export const REASONING_LEVELS = Object.freeze(["max", "high", "medium", "low"]);

/** Every effort value any model maps to, so the picker offers what is in use. */
export function effortValues(roster) {
  const seen = new Set();
  for (const spec of Object.values(roster?.models ?? {})) {
    for (const value of Object.values(spec?.reasoning ?? {})) {
      if (typeof value === "string" && value) seen.add(value);
    }
  }
  return [...seen].sort();
}

/**
 * One row per model: what it is, where it runs, how hard it thinks. Grouping
 * by tier is the panel's job — a model belongs to exactly one, and sending the
 * flat list keeps the tier picker honest about what it is changing.
 */
export function buildTierMatrixView(roster, store = null) {
  const clis = Object.keys(roster?.clis ?? {}).filter((cli) => roster.clis[cli]?.cmd).sort();
  const models = Object.entries(roster?.models ?? {})
    .map(([model, spec]) => ({
      model,
      label: modelLabel(roster, store, model),
      tier: spec?.tier ?? null,
      provider: spec?.provider ?? null,
      priority: spec?.priority ?? null,
      clis: Array.isArray(spec?.cli) ? [...spec.cli].sort() : [],
      reasoning: Object.fromEntries(
        REASONING_LEVELS.map((level) => [level, spec?.reasoning?.[level] ?? null])
      ),
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
  return { tiers: [...TIERS], reasoning_levels: [...REASONING_LEVELS], clis, models,
    effort_values: effortValues(roster) };
}

/**
 * Apply one edit to a roster clone. One edit per call: a request that could
 * mean three things at once is a request nobody can audit later.
 */
export function applyModelEdit(roster, { model, tier, cli, action, level, effort } = {}) {
  const next = structuredClone(roster);
  const spec = next?.models?.[model];
  if (!spec) throw new Error(`unknown model: ${model}`);

  if (tier !== undefined) {
    spec.tier = normalizeTier(tier); // throws on anything but frontier|high|medium|low
    return next;
  }

  if (cli !== undefined) {
    if (!next.clis?.[cli]?.cmd) throw new Error(`unknown cli: ${cli}`);
    const current = new Set(Array.isArray(spec.cli) ? spec.cli : []);
    if (action === "remove") current.delete(cli);
    else if (action === "add") current.add(cli);
    else throw new Error(`unknown action: ${action} (expected add|remove)`);
    if (!current.size) {
      // A model no CLI can run is a cell that silently never resolves.
      throw new Error(`${model} would have no cli left`);
    }
    spec.cli = [...current].sort();
    return next;
  }

  if (level !== undefined) {
    if (!REASONING_LEVELS.includes(level)) {
      throw new Error(`unknown reasoning level: ${level} (expected ${REASONING_LEVELS.join("|")})`);
    }
    spec.reasoning = { ...(spec.reasoning ?? {}) };
    // null is a real answer: it means this model has no such step, which is
    // why composer's `low` and `medium` are empty rather than missing.
    spec.reasoning[level] = effort === null || effort === "" ? null : String(effort);
    return next;
  }

  throw new Error("edit names no field (expected tier, cli+action, or level+effort)");
}

/** Validate, back up, write. A roster the validator rejects is never written. */
export function saveRoster(next, { env = process.env, now = () => new Date() } = {}) {
  const { errors } = validateRoster(next);
  if (errors.length) throw new Error(`roster invalid: ${errors.join("; ")}`);
  const dest = rosterWritePath(env);
  const backup = `${dest}.bak-${now().toISOString().replace(/[:.]/g, "-")}`;
  if (fs.existsSync(dest)) fs.copyFileSync(dest, backup);
  fs.writeFileSync(dest, `${JSON.stringify(next, null, 2)}\n`);
  return { path: dest, backup };
}

/**
 * A specialist's manifest tier is a recommendation: `roster.specialists[id]`
 * overrides it, and `resolveProfile` takes that profile whole — so the
 * override always carries the manifest's reasoning along. `tier: null` drops
 * it, back to the recommendation.
 */
export function applySpecialistTier(roster, { id, tier, reasoning }) {
  const next = structuredClone(roster);
  if (tier == null) {
    if (next.specialists && Object.hasOwn(next.specialists, id)) {
      delete next.specialists[id].model_profile;
      if (!Object.keys(next.specialists[id]).length) delete next.specialists[id];
      if (!Object.keys(next.specialists).length) delete next.specialists;
    }
    return next;
  }
  if (!TIERS.includes(tier)) throw new Error(`tier must be ${TIERS.join("|")}`);
  if (!reasoning) throw new Error("the specialist's manifest names no reasoning level");
  next.specialists ??= {};
  next.specialists[id] = { ...(Object.hasOwn(next.specialists, id) ? next.specialists[id] : {}), model_profile: { tier, reasoning } };
  return next;
}
