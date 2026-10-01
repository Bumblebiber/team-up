// latest.mjs — keep role chains on the newest model a CLI actually offers.
//
// A roster id carries its version (`gpt-5.6-sol`), so a chain written last
// month names last month's model until somebody edits it — or until the CLI
// drops it and every dispatch on that entry fails. The rule here:
//
// - An alias with no version (`claude-opus` → `opus`) already floats at the
//   CLI; nothing to do.
// - A versioned entry moves to the newest roster model of the same family
//   that the CLI's last *fresh* scan lists. Newest means the highest version
//   number, never the catalogue's idea of latest: a CLI that has not shipped
//   a model cannot run it.
// - An object entry with `pinned: true` is the user's override and stays put.
//
// Only fresh, supported scans count. A failed scan says nothing about what the
// CLI offers, so it never removes or moves anything.

import { parseChainEntry, accountBlockReason } from "./chain.mjs";
import { cliModelFor } from "./config.mjs";

const VERSION_TOKEN = /^[a-z]?\d+(?:\.\d+)*$/;

/** `gpt-5.6-sol` → { family: "gpt-sol", version: [5, 6] }; no version → null version. */
export function splitVersion(id) {
  const tokens = String(id).split("-");
  const at = tokens.findIndex((t, i) => i > 0 && VERSION_TOKEN.test(t));
  if (at === -1) return { family: String(id), version: null };
  const version = tokens[at].replace(/^[a-z]/, "").split(".").map(Number);
  const family = [...tokens.slice(0, at), ...tokens.slice(at + 1)].join("-");
  return { family, version };
}

export function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** CLI ids the last fresh scan listed, or null when the scan can't be trusted. */
export function offeredIds(store, cli) {
  const entry = store?.clis?.[cli];
  if (!entry?.supported || entry.stale_since || !Array.isArray(entry.models)) return null;
  return new Set(entry.models.map((m) => m.cli_id));
}

/**
 * Where one chain cell stands against the scan.
 * @returns {{ state: "ok"|"gone"|"unknown", newest: string|null }}
 *   newest = the roster model this cell should name instead, if any.
 */
export function cellStatus(roster, store, cli, model) {
  const offered = offeredIds(store, cli);
  if (!offered) return { state: "unknown", newest: null };
  const present = (id) => offered.has(cliModelFor(roster, id, cli));
  const state = present(model) ? "ok" : "gone";
  const { family, version } = splitVersion(model);
  if (!version) return { state, newest: null };

  let best = null;
  for (const [id, spec] of Object.entries(roster?.models || {})) {
    if (id === model || !spec?.cli?.includes(cli)) continue;
    if (accountBlockReason(roster, spec.account)) continue;
    const other = splitVersion(id);
    if (other.family !== family || !other.version || !present(id)) continue;
    if (state === "ok" && compareVersions(other.version, version) <= 0) continue;
    if (!best || compareVersions(other.version, best.version) > 0) best = { id, version: other.version };
  }
  return { state, newest: best?.id ?? null };
}

/**
 * Rewrite every chain entry that has a newer present sibling.
 * @returns {{ next: object, changes: Array<{ role, cli, from, to, reason }> }}
 */
export function upgradeChains(roster, store) {
  const next = structuredClone(roster);
  const changes = [];
  for (const [role, spec] of Object.entries(next.roles || {})) {
    if (!Array.isArray(spec?.chain)) continue;
    const seen = new Set();
    const chain = [];
    for (const raw of spec.chain) {
      let parsed;
      try {
        parsed = parseChainEntry(raw);
      } catch {
        chain.push(raw);
        continue;
      }
      const pinned = raw && typeof raw === "object" && raw.pinned === true;
      const cli = parsed.cli ?? next.models?.[parsed.model]?.cli?.[0] ?? null;
      let entry = raw;
      if (cli && !pinned) {
        const { state, newest } = cellStatus(next, store, cli, parsed.model);
        if (newest) {
          entry = typeof raw === "string"
            ? (parsed.cli ? `${parsed.cli}:${newest}` : newest)
            : { ...raw, model: newest };
          changes.push({ role, cli, from: parsed.model, to: newest, reason: state === "gone" ? "gone" : "newer" });
        }
      }
      // Two old versions can land on the same new one; keep the first.
      const key = `${cli}:${parseChainEntry(entry).model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chain.push(entry);
    }
    spec.chain = chain;
  }
  return { next, changes };
}
