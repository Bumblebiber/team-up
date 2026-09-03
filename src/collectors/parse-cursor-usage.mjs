// parse-cursor-usage.mjs — pure parser for cursor-agent /usage table.
import { normalizeWindowRecord } from "../usage/usage-windows.mjs";
import { stripAnsi } from "./strip-ansi.mjs";

/**
 * The panel breaks the plan quota into one parent and two children:
 *
 *   Included    11% used      ← the plan allowance as a whole
 *     Auto      12% used      ← requests routed to Cursor's own models
 *     API        1% used      ← third-party models used through Cursor
 *
 * All three are collected under the labels the CLI itself prints. They are not
 * summands of one another — the percentages run against different denominators
 * — so nothing here adds or derives them.
 */
const ROW_RE = /^\s*(Included|Auto|API)\s+(\d+)%\s+used/gim;

/** The panel header carries one reset for the whole plan: "Resets Sep 27". */
const RESET_RE = /Resets\s+([A-Za-z]{3,}\s+\d{1,2})/i;

/**
 * @param {string} text
 * @param {{ now?: string, source?: string }} [opts]
 */
export function parseCursorUsage(text, opts = {}) {
  const updated = opts.now || new Date().toISOString();
  const source = opts.source || "cursor:/usage";
  const normalized = stripAnsi(text);
  const resetRaw = RESET_RE.exec(normalized)?.[1]?.trim() || null;
  const windows = {};
  for (const m of normalized.matchAll(ROW_RE)) {
    const slug = m[1].toLowerCase();
    const key = `cursor:${slug}`;
    windows[key] = normalizeWindowRecord(
      key,
      {
        used: Number(m[2]) / 100,
        resets_at_raw: resetRaw,
        resets_at: null,
        source,
        updated_at: updated,
      },
      { now: updated }
    );
  }
  return windows;
}
