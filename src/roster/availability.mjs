// availability.mjs — do the CLI×model cells a chain names still exist?
//
// Models get retired (an OpenCode free alpha route vanishes) and renamed
// (cursor lists `cursor-grok-4.5-high`, not `grok-4.5-high`). Neither shows up
// in `pick`, which only reads the roster: the cell resolves, dispatch spawns a
// tmux worker, and the CLI rejects the model minutes later with nobody
// watching. Ask the CLIs that can answer, once, from doctor.

import { parseChainEntry } from "./chain.mjs";

/**
 * Subcommand that makes a CLI list its models. The binary itself comes from
 * `clis[cli].cmd[0]`, so an alias in the roster is honoured. A CLI missing
 * here cannot be enumerated (claude, codex, hermes have no such subcommand)
 * and is reported as unknown rather than as a failure.
 */
export const MODEL_LIST_ARGS = {
  opencode: ["models"],
  cursor: ["models"],
};

/**
 * Model ids from a listing. Both known CLIs print one per line, cursor with a
 * " - Display Name" tail; take the first token and ignore prose lines.
 */
export function parseModelIds(text) {
  const ids = new Set();
  for (const line of String(text || "").split("\n")) {
    const token = line.trim().split(/\s+/)[0];
    if (!token || /[:,]$/.test(token)) continue;
    ids.add(token);
  }
  return ids;
}

/** The string buildCommand would hand the CLI for this model. */
export function cliModelFor(roster, model) {
  return roster?.models?.[model]?.cli_model || model;
}

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
      const cli = parsed.cli ?? mod?.cli?.[0] ?? null;
      if (!cli) continue;
      const key = `${cli}:${parsed.model}`;
      if (seen.has(key)) continue;
      seen.set(key, { role, cli, model: parsed.model, sent: cliModelFor(roster, parsed.model) });
    }
  }
  return [...seen.values()];
}

/**
 * Check referenced cells against what each CLI reports.
 *
 * Only a model absent from a CLI that *did* answer is a finding. A CLI that
 * cannot enumerate, or whose listing failed, yields `unknown` — reporting
 * those as missing would bury the real ones in noise.
 *
 * @param {{ roster: object, run?: (bin: string, args: string[]) => string }} opts
 * @returns {Array<{ cli: string, model: string, sent: string, role: string, status: "present"|"missing"|"unknown", reason?: string }>}
 */
export function checkModelAvailability({ roster, run }) {
  const cells = referencedCells(roster);
  const listings = new Map();

  const listFor = (cli) => {
    if (listings.has(cli)) return listings.get(cli);
    let result;
    const args = MODEL_LIST_ARGS[cli];
    const bin = roster?.clis?.[cli]?.cmd?.[0];
    if (!args) result = { ids: null, reason: `${cli} cannot list its models` };
    else if (!bin) result = { ids: null, reason: `no cli template for "${cli}"` };
    else if (!run) result = { ids: null, reason: "no runner" };
    else {
      try {
        const ids = parseModelIds(run(bin, args));
        result = ids.size
          ? { ids }
          : { ids: null, reason: `${bin} ${args.join(" ")} listed nothing` };
      } catch (e) {
        result = { ids: null, reason: `${bin} ${args.join(" ")} failed: ${e.message || e}` };
      }
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
