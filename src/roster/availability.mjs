// availability.mjs — do chain-referenced CLI×model cells still exist at the CLI?
//
// Models get retired and renamed. Pick only reads the roster; dispatch spawns
// a worker and the CLI rejects the model later. Ask CLIs that can answer.

import { parseChainEntry, accountBlockReason } from "./chain.mjs";
import { cliModelFor } from "./config.mjs";
import {
  LIST_ARGS,
  collectCliModels,
  parseModelIds,
} from "../collectors/cli-models.mjs";

export { LIST_ARGS as MODEL_LIST_ARGS, parseModelIds };

/**
 * Every distinct CLI×model cell any role chain names.
 * @returns {Array<{ role: string, cli: string, model: string, sent: string }>}
 */
export function referencedCells(roster) {
  const seen = new Map();
  for (const [role, spec] of Object.entries(roster?.roles || {})) {
    for (const raw of spec?.chain || []) {
      let parsed;
      try {
        parsed = parseChainEntry(raw);
      } catch {
        continue;
      }
      const mod = roster.models?.[parsed.model];
      if (accountBlockReason(roster, mod?.account)) continue;
      const cli = parsed.cli ?? mod?.cli?.[0] ?? null;
      if (!cli) continue;
      const key = `${cli}:${parsed.model}`;
      if (seen.has(key)) continue;
      seen.set(key, { role, cli, model: parsed.model, sent: cliModelFor(roster, parsed.model, cli) });
    }
  }
  return [...seen.values()];
}

/**
 * Check referenced cells against what each CLI reports.
 *
 * Only a model absent from a CLI that *did* answer is `missing`. A CLI that
 * cannot enumerate, or whose listing failed, yields `unknown`.
 *
 * @param {{ roster: object, run?: (bin: string, args: string[]) => string }} opts
 * @returns {Array<{ cli: string, model: string, sent: string, role: string, status: "present"|"missing"|"unknown", reason?: string }>}
 */
export function checkModelAvailability({ roster, run }) {
  const cells = referencedCells(roster);
  const listings = new Map();

  const listFor = (cli) => {
    if (listings.has(cli)) return listings.get(cli);
    // Only CLIs with a plain listing subcommand are asked here. claude and
    // codex can be enumerated, but only through a `/model` session that costs
    // a full CLI boot — and this runs from the doctor cron. A false "missing"
    // would be noise on every run and get the whole check tuned out, and a
    // billed print session per cron tick is not what a health check is for.
    // `team-up models scan` drives those two, deliberately and on demand.
    if (!LIST_ARGS[cli]) {
      const result = { ids: null, reason: `${cli} needs \`team-up models scan\` to enumerate` };
      listings.set(cli, result);
      return result;
    }
    const collected = collectCliModels(cli, { roster, run });
    let result;
    if (!collected.supported) {
      result = { ids: null, reason: collected.reason };
    } else {
      const ids = new Set(collected.models.map((m) => m.id));
      result = { ids };
    }
    listings.set(cli, result);
    return result;
  };

  return cells.map((cell) => {
    const { ids, reason } = listFor(cell.cli);
    if (!ids) return { ...cell, status: "unknown", reason };
    return { ...cell, status: ids.has(cell.sent) ? "present" : "missing" };
  });
}
