// parse-codex-status.mjs — pure parser for codex /status output.
import { normalizeWindowRecord } from "../usage/usage-windows.mjs";

const LIMIT_LINE_RE =
  /([A-Za-z0-9][A-Za-z0-9 ]*?)\s+limit:\s+.*?(\d+)%\s+left\s*\(resets\s+([^)]+)\)/gi;
const HIT_LIMIT_RE = /hit your usage limit.*?try again at\s+([^.]+)/is;

function stripAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[()][AB012]/g, "")
    .replace(/\r/g, "");
}

function labelToWindowKey(label) {
  const norm = label.trim().toLowerCase();
  if (norm === "weekly") return "codex:weekly";
  if (norm === "5h" || norm === "5 h" || norm.includes("5h") || norm.includes("hour")) {
    return "codex:5h";
  }
  return `codex:${norm.replace(/\s+/g, "-")}`;
}

/**
 * @param {string} text
 * @param {{ now?: string, source?: string }} [opts]
 */
export function parseCodexStatus(text, opts = {}) {
  const updated = opts.now || new Date().toISOString();
  const source = opts.source || "codex:/status";
  const windows = {};
  const normalized = stripAnsi(text);

  for (const match of normalized.matchAll(LIMIT_LINE_RE)) {
    const label = match[1];
    const left = Number(match[2]);
    const raw = match[3].trim();
    const wkey = labelToWindowKey(label);
    windows[wkey] = normalizeWindowRecord(
      wkey,
      {
        used: Math.min(1, Math.max(0, 1 - left / 100)),
        resets_at_raw: raw,
        resets_at: raw,
        source,
        updated_at: updated,
      },
      { now: updated }
    );
  }

  if (Object.keys(windows).length === 0 && HIT_LIMIT_RE.test(normalized)) {
    const raw = HIT_LIMIT_RE.exec(normalized)?.[1]?.trim() || null;
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
