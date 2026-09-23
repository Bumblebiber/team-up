// models-list.mjs — read persisted models.json without spawning CLIs.

import {
  formatStoreAge,
  loadModelsStore,
  storeAge,
} from "../collectors/models-store.mjs";

function formatCliEntry(cliId, entry) {
  const lines = [`## ${cliId}`];
  if (!entry) {
    lines.push("no data");
    return lines.join("\n");
  }
  if (!entry.supported) {
    lines.push(`unsupported: ${entry.reason || "unknown"}`);
    if (entry.stale_since) lines.push(`stale since: ${entry.stale_since}`);
    return lines.join("\n");
  }
  if (entry.stale_since) lines.push(`stale since: ${entry.stale_since}`);
  lines.push(`models: ${entry.models?.length ?? 0}`);
  for (const m of entry.models || []) {
    const cur = m.current ? " (current)" : "";
    lines.push(`  - ${m.cli_id} — ${m.display_name}${cur}`);
  }
  if (entry.gone?.length) {
    lines.push(`gone: ${entry.gone.length}`);
    for (const g of entry.gone) lines.push(`  - ${g.roster_id} → sent "${g.sent}"`);
  }
  if (entry.new_count) lines.push(`new (last scan): ${entry.new_count}`);
  return lines.join("\n");
}

/**
 * @param {string[]} args
 * @param {{ out: Function, err: Function }} io
 * @param {{ env?: object }} [deps]
 */
export function runModelsList(args, io, { env = process.env } = {}) {
  const json = args.includes("--json");
  const cliIdx = args.indexOf("--cli");
  const cliFilter = cliIdx === -1 ? undefined : args[cliIdx + 1];
  if (cliFilter !== undefined && !cliFilter) {
    io.err("usage: team-up models list [--cli <id>] [--json]");
    return 1;
  }

  const store = loadModelsStore(env);
  const { age_ms, scanned_at } = storeAge(store);
  const ageLabel = formatStoreAge(age_ms);

  if (!store?.clis || !Object.keys(store.clis).length) {
    if (json) {
      io.out(JSON.stringify({ scanned_at, age_ms, clis: {} }, null, 0));
      return 0;
    }
    io.out(`models.json: empty (scanned ${ageLabel})`);
    return 0;
  }

  const cliIds = cliFilter ? [cliFilter] : Object.keys(store.clis).sort();
  if (cliFilter && !store.clis[cliFilter]) {
    io.err(`no persisted data for cli "${cliFilter}"`);
    return 1;
  }

  if (json) {
    const clis = {};
    for (const id of cliIds) clis[id] = store.clis[id];
    io.out(JSON.stringify({ scanned_at, age_ms, clis }, null, 0));
    return 0;
  }

  io.out(`models.json scanned ${ageLabel} (${scanned_at || "never"})`);
  const blocks = cliIds.map((id) => formatCliEntry(id, store.clis[id]));
  io.out(blocks.join("\n\n"));
  return 0;
}
