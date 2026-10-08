import fs from "node:fs";
import path from "node:path";
import { rosterPath as configPathFromPaths, usagePath as usagePathFromPaths, rosterWritePath, usageWritePath } from "../paths.mjs";
import { parseChainEntry } from "./chain.mjs";
import { atomicWriteJson } from "../json-store.mjs";

export function configPath(env = process.env) {
  return configPathFromPaths(env);
}

export function usagePath() {
  return usagePathFromPaths();
}

export { rosterWritePath, usageWritePath };

/**
 * The plans a subscription account may name, keyed by account id. Information
 * only: the CLIs report usage as a share of their own plan, and admission
 * sizes by host memory, so no threshold reads the plan.
 */
export const PLAN_TIERS = {
  claude: ["pro", "max5x", "max20x"],
  codex: ["plus", "pro", "business", "enterprise"],
  cursor: ["hobby", "pro", "pro_plus", "ultra", "teams"],
  gemini: ["free", "plus", "pro", "ultra"],
};

/** JSON.parse a file; ENOENT -> null; malformed JSON rethrows. */
export function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Structural sanity check for roster.json.
 * @returns {{ errors: string[], warnings: string[] }}
 */
/**
 * The model id a CLI expects for `{model}`.
 *
 * `cli_model` is either one alias for every CLI (a string) or a map keyed by
 * CLI. The map exists because one logical model is spelled differently per
 * CLI — cursor wants `cursor-grok-4.5-high`, opencode `openrouter/x-ai/grok-4.5`
 * — and a single alias can only ever be right for one of them, silently
 * sending a wrong id to the others. An unlisted CLI falls back to the roster's
 * own model id, which is the correct answer whenever the CLI needs no alias.
 */
export function cliModelFor(roster, model, cli, effort = null) {
  const spec = roster?.models?.[model];
  return fillEffort(aliasFor(spec, model, cli), effortFor(spec, effort));
}

/**
 * Cursor spells the effort into the model id (`grok-4.7-high`). Such a model's
 * alias is a template, `grok-4.7-{effort}`, filled at dispatch; the Models tab
 * shows one row per template. Other CLIs stay literal — OpenRouter has real
 * names ending in `-high`.
 * ponytail: token heuristic over cursor's naming; a new effort word needs
 * adding here.
 */
export const EFFORT_IN_NAME = new Set(["cursor"]);
const EFFORT_TOKEN = /-(extra-high|xhigh|minimal|none|low|medium|high|max)(?=-|$)/;

/** `grok-4.7-{effort}` + `high` → `grok-4.7-high`; no effort → the bare id. */
export function fillEffort(alias, effort) {
  if (!alias.includes("{effort}")) return alias;
  return effort ? alias.replace("{effort}", effort) : alias.replace("-{effort}", "");
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "extra-high", "max"];
const byRank = (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b);

/**
 * The effort a template gets: one of the model's own steps as given, a
 * reasoning level (`max`) through the model's map, else the strongest step at
 * or below the one asked for (a chain's `xhigh` moved onto a version without
 * it), else the model's default. Never an id the CLI does not list.
 */
function effortFor(spec, effort) {
  const steps = [...new Set([...(spec?.efforts || []), ...Object.values(spec?.reasoning || {}).filter(Boolean)])].sort(byRank);
  if (effort && steps.includes(effort)) return effort;
  if (effort && spec?.reasoning?.[effort]) return spec.reasoning[effort];
  if (EFFORT_ORDER.includes(effort) && steps.length) {
    return steps.filter((x) => byRank(x, effort) <= 0).pop() ?? steps[0];
  }
  return spec?.effort || null;
}

/**
 * Cursor's ids folded per model: `[{ id: template-or-id, base, efforts }]`.
 * A bare id (`gpt-5.2`) joins the template it is the default of.
 */
export function groupEfforts(ids) {
  const groups = new Map();
  for (const id of ids) {
    const m = id.match(EFFORT_TOKEN);
    const key = m ? id.replace(EFFORT_TOKEN, "-{effort}") : id;
    if (!groups.has(key)) groups.set(key, { id: key, base: fillEffort(key, null), efforts: [] });
    if (m) groups.get(key).efforts.push(m[1]);
  }
  for (const [key, g] of groups) {
    if (key.includes("{effort}")) continue;
    const tpl = [...groups.values()].find((o) => o.id.includes("{effort}") && o.base === key);
    if (tpl) { tpl.bare = true; groups.delete(key); }
  }
  for (const g of groups.values()) g.efforts.sort(byRank);
  return [...groups.values()];
}

/**
 * Reasoning map and default for a template's efforts. The default is the one
 * a fill with no effort sends, so it must exist: the bare id, else `medium`,
 * else the first the CLI lists.
 */
export function effortSpec({ efforts, bare }) {
  const has = (...xs) => xs.find((x) => efforts.includes(x)) ?? null;
  return {
    reasoning: { max: has("max", "xhigh", "extra-high", "high"), high: has("high"), medium: has("medium"), low: has("low", "minimal", "none") },
    efforts: [...efforts],
    ...(bare ? {} : { effort: has("medium") ?? efforts[0] }),
  };
}

/** Same resolution against a model object the caller already holds. */
export function aliasFor(modelDef, modelId, cli) {
  const alias = modelDef?.cli_model;
  if (typeof alias === "string" && alias) return alias;
  if (alias && typeof alias === "object" && !Array.isArray(alias)) {
    const hit = cli == null ? null : alias[cli];
    return typeof hit === "string" && hit ? hit : modelId;
  }
  return modelId;
}

/** Every id a model answers to, for free-text model resolution. */
export function cliModelAliases(modelDef, modelId) {
  const alias = modelDef?.cli_model;
  if (typeof alias === "string" && alias) return [alias];
  if (alias && typeof alias === "object" && !Array.isArray(alias)) {
    return [...new Set(Object.values(alias).filter((v) => typeof v === "string" && v))];
  }
  return [modelId];
}

export function validateRoster(roster) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(roster)) {
    return { errors: ["roster is not a JSON object"], warnings };
  }

  for (const key of ["models", "roles", "clis", "accounts"]) {
    if (roster[key] !== undefined && !isPlainObject(roster[key])) {
      errors.push(`${key} must be an object`);
    }
  }

  if (isPlainObject(roster.accounts)) {
    for (const [id, account] of Object.entries(roster.accounts)) {
      if (!isPlainObject(account)) {
        errors.push(`accounts.${id} must be an object`);
        continue;
      }
      if (account.kind !== "subscription" && account.kind !== "credit") {
        errors.push(`accounts.${id}.kind must be subscription|credit`);
      }
      if (typeof account.enabled !== "boolean") {
        errors.push(`accounts.${id}.enabled must be boolean`);
      }
      if (account.kind === "credit" && account.remaining !== undefined &&
        typeof account.remaining !== "number") {
        errors.push(`accounts.${id}.remaining must be a number`);
      }
      if (account.plan !== undefined &&
        !(account.kind === "subscription" && PLAN_TIERS[id]?.includes(account.plan))) {
        errors.push(`accounts.${id}.plan must be one of ${(PLAN_TIERS[id] || []).join("|") || "(none for this account)"}`);
      }
    }
  }

  if (isPlainObject(roster.clis)) {
    for (const [id, cli] of Object.entries(roster.clis)) {
      if (!isPlainObject(cli)) errors.push(`clis.${id} must be an object`);
      else if (cli.cmd !== undefined &&
        (!Array.isArray(cli.cmd) || cli.cmd.some((p) => typeof p !== "string"))) {
        errors.push(`clis.${id}.cmd must be an array of strings`);
      }
    }
  }

  if (isPlainObject(roster.models)) {
    for (const [id, model] of Object.entries(roster.models)) {
      if (!isPlainObject(model)) {
        errors.push(`models.${id} must be an object`);
        continue;
      }
      if (model.cli !== undefined &&
        (!Array.isArray(model.cli) || model.cli.some((c) => typeof c !== "string"))) {
        errors.push(`models.${id}.cli must be an array of strings`);
      }
      if (model.provider !== undefined && typeof model.provider !== "string") {
        errors.push(`models.${id}.provider must be a string`);
      }
      if (model.effort !== undefined && typeof model.effort !== "string") {
        errors.push(`models.${id}.effort must be a string`);
      }
      if (model.account !== undefined && isPlainObject(roster.accounts) && !roster.accounts[model.account]) {
        errors.push(`models.${id}.account "${model.account}" not in accounts`);
      }
    }
  }

  if (isPlainObject(roster.roles)) {
    for (const [id, role] of Object.entries(roster.roles)) {
      if (!isPlainObject(role) || !Array.isArray(role.chain) || role.chain.length === 0) {
        errors.push(`roles.${id}.chain must be a non-empty array`);
        continue;
      }
      if (role.effort !== undefined && typeof role.effort !== "string") {
        errors.push(`roles.${id}.effort must be a string`);
      }
      for (const entry of role.chain) {
        let parsed;
        try {
          parsed = parseChainEntry(entry);
        } catch (e) {
          errors.push(`roles.${id}: ${e.message}`);
          continue;
        }
        if (isPlainObject(roster.models) && !roster.models[parsed.model]) {
          warnings.push(`roles.${id}: chain entry "${parsed.model}" not in models (will be skipped)`);
        }
        if (parsed.cli && isPlainObject(roster.clis) && !roster.clis[parsed.cli]) {
          warnings.push(`roles.${id}: chain entry pins cli "${parsed.cli}" with no clis template (will be skipped)`);
        }
      }
    }
  }

  if (roster.limits !== undefined) {
    if (!isPlainObject(roster.limits)) {
      errors.push("limits must be an object");
    } else {
      for (const key of ["warn_at", "handoff_at", "handoff_at_burst"]) {
        const v = roster.limits[key];
        if (v !== undefined && (typeof v !== "number" || !(v > 0 && v <= 1))) {
          errors.push(`limits.${key} must be a number in (0, 1]`);
        }
      }
    }
  }

  // A specialist runs on a role's chain or on a chain of its own — exactly one.
  if (roster.specialists !== undefined) {
    if (!isPlainObject(roster.specialists)) {
      errors.push("specialists must be an object");
    } else {
      for (const [id, spec] of Object.entries(roster.specialists)) {
        const hasRole = isPlainObject(spec) && spec.role !== undefined;
        const hasChain = isPlainObject(spec) && spec.chain !== undefined;
        if (hasRole === hasChain) {
          errors.push(`specialists.${id} needs exactly one of role or chain`);
        } else if (hasRole && !(isPlainObject(roster.roles) && Object.hasOwn(roster.roles, spec.role))) {
          errors.push(`specialists.${id}.role "${spec.role}" not in roles`);
        } else if (hasChain) {
          if (!Array.isArray(spec.chain) || !spec.chain.length) {
            errors.push(`specialists.${id}.chain must be a non-empty array`);
          } else {
            for (const entry of spec.chain) {
              let parsed;
              try {
                parsed = parseChainEntry(entry);
              } catch (e) {
                errors.push(`specialists.${id}: ${e.message}`);
                continue;
              }
              if (isPlainObject(roster.models) && !roster.models[parsed.model]) {
                warnings.push(`specialists.${id}: chain entry "${parsed.model}" not in models (will be skipped)`);
              }
              if (parsed.cli && isPlainObject(roster.clis) && !roster.clis[parsed.cli]) {
                warnings.push(`specialists.${id}: chain entry pins cli "${parsed.cli}" with no clis template (will be skipped)`);
              }
            }
          }
        }
      }
    }
  }

  if (roster.openrouter?.key_file !== undefined && typeof roster.openrouter.key_file !== "string") {
    errors.push("openrouter.key_file must be a string");
  }

  return { errors, warnings };
}

export function requireRoster() {
  const roster = loadJson(configPath());
  if (!roster) {
    console.error(`no roster config at ${configPath()} — run: team-up init`);
    process.exit(1);
  }
  const { errors, warnings } = validateRoster(roster);
  for (const w of warnings) console.error(`roster.json warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`roster.json invalid: ${e}`);
    console.error(`fix ${configPath()} and re-run`);
    process.exit(1);
  }
  return roster;
}

/** Validate, back up, write. A roster the validator rejects is never written. */
export function saveRoster(next, { env = process.env, now = () => new Date() } = {}) {
  const { errors } = validateRoster(next);
  if (errors.length) throw new Error(`roster invalid: ${errors.join("; ")}`);
  const dest = rosterWritePath(env);
  const backup = `${dest}.bak-${now().toISOString().replace(/[:.]/g, "-")}`;
  if (fs.existsSync(dest)) fs.copyFileSync(dest, backup);
  // Atomic: every dispatch, hook and the watcher read roster.json meanwhile.
  atomicWriteJson(dest, next);
  return { path: dest, backup };
}
