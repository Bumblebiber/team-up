import fs from "node:fs";
import path from "node:path";
import { rosterPath as configPathFromPaths, usagePath as usagePathFromPaths, rosterWritePath, usageWritePath } from "../paths.mjs";
import { parseChainEntry } from "./chain.mjs";

export function configPath(env = process.env) {
  return configPathFromPaths(env);
}

export function usagePath() {
  return usagePathFromPaths();
}

export { rosterWritePath, usageWritePath };

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
export function cliModelFor(roster, model, cli) {
  return aliasFor(roster?.models?.[model], model, cli);
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

/** Every id a model answers to, for name resolution (pass-to). */
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
      // Specialist-eligible (tiered) models require account + reasoning map
      if (model.tier !== undefined) {
        if (!model.account || typeof model.account !== "string") {
          errors.push(`models.${id}.account required for tiered/specialist-eligible models`);
        } else if (isPlainObject(roster.accounts) && !roster.accounts[model.account]) {
          errors.push(`models.${id}.account "${model.account}" not in accounts`);
        }
        if (!isPlainObject(model.reasoning)) {
          errors.push(`models.${id}.reasoning map required for tiered/specialist-eligible models`);
        }
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
