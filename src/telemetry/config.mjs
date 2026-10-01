import { configPath, loadJson } from "../roster/config.mjs";
import { DEFAULT_RETENTION_DAYS } from "./store.mjs";
import { DEFAULT_THRESHOLDS } from "./restart.mjs";

/**
 * The `telemetry` block of roster.json:
 *
 *   "telemetry": {
 *     "retention_days": 7,
 *     "verdict": { "mem_available_ratio": 0.05, "psi_full_avg10": 20, "team_up_share": 0.5 }
 *   }
 *
 * A wrong value is an error, not a silent default: a threshold that quietly
 * fell back would decide a restart verdict nobody configured.
 */
export function telemetryConfig(env = process.env, { roster } = {}) {
  const doc = roster === undefined ? loadJson(configPath(env)) : roster;
  const raw = doc?.telemetry ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("TELEMETRY_CONFIG: telemetry must be an object");
  const retention = raw.retention_days ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(retention) || retention < 1) {
    throw new Error("TELEMETRY_CONFIG: telemetry.retention_days must be a positive integer");
  }
  const verdict = { ...DEFAULT_THRESHOLDS };
  for (const [key, value] of Object.entries(raw.verdict ?? {})) {
    if (!(key in DEFAULT_THRESHOLDS)) throw new Error(`TELEMETRY_CONFIG: unknown telemetry.verdict.${key}`);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`TELEMETRY_CONFIG: telemetry.verdict.${key} must be a non-negative number`);
    }
    verdict[key] = value;
  }
  return { retention_days: retention, verdict };
}
