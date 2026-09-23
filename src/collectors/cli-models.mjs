// cli-models.mjs — non-interactive CLI model listings for roster reconciliation.
// Each adapter either returns parsed models or an honest unsupported result.
// Parsing is pure; the runner is injectable for tests.

import { execFileSync } from "node:child_process";
import { cliModelFor, cliModelAliases } from "../roster/config.mjs";

/** Short enough for doctor cron; long enough for a cold CLI start. */
export const LIST_TIMEOUT_MS = 5_000;

/**
 * Subcommand argv (after the binary) for CLIs that expose a plain listing.
 * Verified on host 2026-09-23. CLIs missing here have no non-interactive source.
 */
export const LIST_ARGS = {
  cursor: ["models"],
  opencode: ["models"],
};

/** Documented reasons for CLIs with no listing command. */
export const UNSUPPORTED_REASONS = {
  codex: "codex has no models subcommand",
  claude: "claude has no models listing command",
  hermes: "hermes has no models listing command (model subcommand is interactive)",
};

/**
 * Parse `cursor-agent models` output: `id - Display Name` with optional `(current)`.
 * @returns {Array<{ id: string, display_name: string, current?: true }>}
 */
export function parseCursorModels(text) {
  const models = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const dash = trimmed.indexOf(" - ");
    if (dash === -1) continue;
    const id = trimmed.slice(0, dash).trim();
    if (!id) continue;
    let display = trimmed.slice(dash + 3).trim();
    const current = /\s+\(current\)\s*$/i.test(display);
    display = display.replace(/\s+\(current\)\s*$/i, "").trim();
    models.push({ id, display_name: display || id, ...(current ? { current: true } : {}) });
  }
  return models;
}

/**
 * Parse `opencode models` output: one model id per line.
 * @returns {Array<{ id: string, display_name: string }>}
 */
export function parseOpencodeModels(text) {
  const models = [];
  for (const line of String(text || "").split("\n")) {
    const id = line.trim();
    if (!id || /\s/.test(id)) continue;
    models.push({ id, display_name: id });
  }
  return models;
}

const PARSERS = {
  cursor: parseCursorModels,
  opencode: parseOpencodeModels,
};

/**
 * Model ids from a listing (legacy helper for availability checks).
 * Takes the first token per line; drops prose headings.
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

/**
 * @param {string} cliId
 * @param {{ roster: object, run?: (bin: string, args: string[]) => string }} opts
 * @returns {{ supported: true, models: Array<{id, display_name, current?}> } | { supported: false, reason: string }}
 */
export function collectCliModels(cliId, { roster, run }) {
  const args = LIST_ARGS[cliId];
  if (!args) {
    return {
      supported: false,
      reason: UNSUPPORTED_REASONS[cliId] || `${cliId} cannot list its models`,
    };
  }
  const bin = roster?.clis?.[cliId]?.cmd?.[0];
  if (!bin) return { supported: false, reason: `no cli template for "${cliId}"` };
  if (!run) return { supported: false, reason: "no runner" };
  try {
    const text = run(bin, args);
    const parser = PARSERS[cliId];
    const models = parser(text);
    if (!models.length) {
      return { supported: false, reason: `${bin} ${args.join(" ")} listed nothing` };
    }
    return { supported: true, models };
  } catch (e) {
    return {
      supported: false,
      reason: `${bin} ${args.join(" ")} failed: ${e.message || e}`,
    };
  }
}

/** Roster models that declare this CLI, with the id the CLI would receive. */
export function rosterEntriesForCli(roster, cliId) {
  const entries = [];
  for (const [rosterId, mod] of Object.entries(roster?.models || {})) {
    if (!mod?.cli?.includes(cliId)) continue;
    const sent = cliModelFor(roster, rosterId, cliId);
    const aliases = cliModelAliases(mod, rosterId);
    entries.push({ roster_id: rosterId, sent, aliases });
  }
  return entries;
}

/**
 * Join CLI listing against roster.models for one CLI.
 * @returns {{ cli: string, supported: boolean, reason?: string, known?: unknown[], new?: unknown[], gone?: unknown[] }}
 */
export function scanCliModels(cliId, { roster, run }) {
  const collected = collectCliModels(cliId, { roster, run });
  if (!collected.supported) {
    return { cli: cliId, supported: false, reason: collected.reason };
  }

  const rosterEntries = rosterEntriesForCli(roster, cliId);
  const sentToRoster = new Map();
  for (const entry of rosterEntries) {
    sentToRoster.set(entry.sent, entry.roster_id);
    sentToRoster.set(entry.roster_id, entry.roster_id);
    for (const alias of entry.aliases) sentToRoster.set(alias, entry.roster_id);
  }

  const cliIdSet = new Set(collected.models.map((m) => m.id));
  const known = [];
  const fresh = [];
  for (const m of collected.models) {
    const rosterId = sentToRoster.get(m.id);
    if (rosterId) {
      known.push({
        cli_id: m.id,
        roster_id: rosterId,
        display_name: m.display_name,
        ...(m.current ? { current: true } : {}),
      });
    } else {
      fresh.push({
        cli_id: m.id,
        display_name: m.display_name,
        ...(m.current ? { current: true } : {}),
      });
    }
  }

  const gone = [];
  for (const entry of rosterEntries) {
    if (!cliIdSet.has(entry.sent)) {
      gone.push({ roster_id: entry.roster_id, sent: entry.sent });
    }
  }

  return { cli: cliId, supported: true, known, new: fresh, gone };
}

/**
 * Scan every CLI in the roster (or one with --cli).
 * @param {{ roster: object, cliFilter?: string, run?: Function }} opts
 */
export function scanModels({ roster, cliFilter, run }) {
  const cliIds = cliFilter ? [cliFilter] : Object.keys(roster?.clis || {});
  return cliIds.map((cliId) => scanCliModels(cliId, { roster, run }));
}

/** Default runner: execFileSync with a short timeout, no shell. */
export function defaultRun(bin, args) {
  return execFileSync(bin, args, {
    encoding: "utf8",
    timeout: LIST_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
}
