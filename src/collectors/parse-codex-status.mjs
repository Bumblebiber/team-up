// parse-codex-status.mjs — pure parser for codex /status output.
import { normalizeWindowRecord } from "../usage/usage-windows.mjs";

const WEEKLY_RE = /Weekly\s+limit:\s+.*?(\d+)%\s+left\s*\(resets\s+([^)]+)\)/is;
const HIT_LIMIT_RE = /hit your usage limit.*?try again at\s+([^.]+)/is;

/**
 * @param {string} text
 * @param {{ now?: string, source?: string }} [opts]
 */
export function parseCodexStatus(text, opts = {}) {
  const updated = opts.now || new Date().toISOString();
  const source = opts.source || "codex:/status";
  const windows = {};

  const weekly = WEEKLY_RE.exec(text);
  if (weekly) {
    const left = Number(weekly[1]);
    const raw = weekly[2].trim();
    windows["codex:weekly"] = normalizeWindowRecord(
      "codex:weekly",
      {
        used: Math.min(1, Math.max(0, 1 - left / 100)),
        resets_at_raw: raw,
        resets_at: raw,
        source,
        updated_at: updated,
      },
      { now: updated }
    );
  } else if (HIT_LIMIT_RE.test(text)) {
    const raw = HIT_LIMIT_RE.exec(text)?.[1]?.trim() || null;
    windows["codex:weekly"] = normalizeWindowRecord(
      "codex:weekly",
      {
        used: 1,
        resets_at_raw: raw,
        resets_at: raw,
        source,
        updated_at: updated,
      },
      { now: updated }
    );
  }

  return windows;
}
