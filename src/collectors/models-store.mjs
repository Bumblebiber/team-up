// models-store.mjs — persist CLI model listings to ~/.team-up/models.json

import fs from "node:fs";
import { atomicWriteText, loadJson } from "../json-store.mjs";
import { modelsPath, modelsWritePath } from "../paths.mjs";

/**
 * @param {object | null} previous
 * @param {Array<{ cli: string, supported: boolean, reason?: string, known?: unknown[], new?: unknown[], gone?: unknown[] }>} reports
 * @param {Map<string, { supported: boolean, reason?: string, models?: Array<{id, display_name, current?}> }>} collectedByCli
 * @param {string} scannedAt
 */
export function mergeModelsStore(previous, reports, collectedByCli, scannedAt) {
  const prev = previous?.clis && typeof previous.clis === "object" ? previous.clis : {};
  const clis = { ...prev };

  for (const report of reports) {
    const cliId = report.cli;
    const collected = collectedByCli.get(cliId);
    if (!collected?.supported) {
      const prior = prev[cliId];
      if (prior) {
        clis[cliId] = {
          ...prior,
          supported: prior.supported ?? true,
          reason: collected?.reason || report.reason,
          stale_since: prior.stale_since || scannedAt,
        };
      } else {
        clis[cliId] = {
          supported: false,
          reason: collected?.reason || report.reason,
          scanned_at: scannedAt,
          stale_since: scannedAt,
        };
      }
      continue;
    }

    clis[cliId] = {
      supported: true,
      scanned_at: scannedAt,
      models: (collected.models || []).map((m) => ({
        cli_id: m.id,
        display_name: m.display_name,
        ...(m.current ? { current: true } : {}),
      })),
      gone: report.gone || [],
      new_count: report.new?.length ?? 0,
    };
    delete clis[cliId].stale_since;
    delete clis[cliId].reason;
  }

  return { scanned_at: scannedAt, clis };
}

export function loadModelsStore(env = process.env) {
  return loadJson(modelsPath(env));
}

export function writeModelsStore(store, env = process.env) {
  const dest = modelsWritePath(env);
  atomicWriteText(dest, `${JSON.stringify(store, null, 2)}\n`);
  return dest;
}

/**
 * @param {object | null} store
 * @returns {{ age_ms: number | null, scanned_at: string | null }}
 */
export function storeAge(store) {
  const scannedAt = store?.scanned_at;
  if (!scannedAt) return { age_ms: null, scanned_at: null };
  const age = Date.now() - Date.parse(scannedAt);
  return { age_ms: Number.isFinite(age) ? age : null, scanned_at: scannedAt };
}

export function formatStoreAge(ageMs) {
  if (ageMs == null) return "unknown age";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}
