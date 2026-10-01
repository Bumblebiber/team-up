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

/** A scan older than this says nothing about today — models get added after it. */
export const SCAN_MAX_AGE_MS = 48 * 3600 * 1000;

/** CLI ids the last fresh scan listed, or null when the scan can't be trusted. */
export function offeredIds(store, cli, now = Date.now()) {
  const entry = store?.clis?.[cli];
  if (!entry?.supported || entry.stale_since || !Array.isArray(entry.models)) return null;
  const age = now - Date.parse(entry.scanned_at ?? store?.scanned_at);
  if (!(age <= SCAN_MAX_AGE_MS)) return null;
  return new Set(entry.models.map((m) => m.cli_id));
}

/**
 * A CLI that ships `gpt-7-sol` while the roster only knows `gpt-6-sol` has
 * nothing to move a chain to — the model is not in `roster.models`. Add it as
 * a copy of its newest sibling on that CLI (tier, reasoning, account, limit
 * windows), minus anything that describes the old version (price, notes).
 * Only families the roster already runs on that CLI; a new family is a
 * judgement for `team-up propose`, not for a version bump.
 * @returns {{ next: object, added: Array<{ id, cli, from }> }}
 */
export function addOfferedVersions(roster, store, now = Date.now()) {
  const next = structuredClone(roster);
  const added = [];
  for (const cli of Object.keys(store?.clis || {})) {
    const offered = offeredIds(store, cli, now);
    if (!offered) continue;
    for (const cliId of offered) {
      if (Object.hasOwn(next.models || {}, cliId)) continue;
      const { family, version } = splitVersion(cliId);
      if (!version) continue;
      let sibling = null;
      for (const [id, spec] of Object.entries(next.models || {})) {
        if (!spec?.cli?.includes(cli) || spec.cli_model) continue;
        const other = splitVersion(id);
        if (other.family !== family || !other.version) continue;
        if (!sibling || compareVersions(other.version, sibling.version) > 0) sibling = { id, spec, version: other.version };
      }
      if (!sibling || compareVersions(version, sibling.version) <= 0) continue;
      const { price, notes, $comment, strengths, weaknesses, ...spec } = sibling.spec;
      next.models[cliId] = { ...structuredClone(spec), cli: [cli] };
      added.push({ id: cliId, cli, from: sibling.id });
    }
  }
  return { next, added };
}

/**
 * Where one chain cell stands against the scan.
 * @returns {{ state: "ok"|"gone"|"unknown", newest: string|null }}
 *   newest = the roster model this cell should name instead, if any.
 */
export function cellStatus(roster, store, cli, model, now = Date.now()) {
  const offered = offeredIds(store, cli, now);
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
export function upgradeChains(roster, store, now = Date.now()) {
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
        const { state, newest } = cellStatus(next, store, cli, parsed.model, now);
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

/**
 * Drop the roster models a CLI no longer offers, once no chain names them.
 * A gone model a chain still names stays: it has no successor (or is pinned),
 * and the dashboard flags it red until a human deletes or replaces it. A model
 * on a switched-off account stays too — the scan can't see it while it's off.
 * A model on several CLIs only loses the CLI that dropped it.
 * @returns {{ next: object, removed: Array<{ id, cli }> }}
 */
export function pruneGone(roster, store, now = Date.now()) {
  const next = structuredClone(roster);
  const removed = [];
  const named = new Set();
  for (const spec of Object.values(next.roles || {})) {
    for (const raw of Array.isArray(spec?.chain) ? spec.chain : []) {
      try {
        named.add(parseChainEntry(raw).model);
      } catch {}
    }
  }
  for (const [id, spec] of Object.entries(next.models || {})) {
    if (named.has(id) || !Array.isArray(spec?.cli) || accountBlockReason(next, spec.account)) continue;
    const dropped = spec.cli.filter((cli) => offeredIds(store, cli, now)?.has(cliModelFor(next, id, cli)) === false);
    if (!dropped.length) continue;
    for (const cli of dropped) removed.push({ id, cli });
    spec.cli = spec.cli.filter((cli) => !dropped.includes(cli));
    if (!spec.cli.length) delete next.models[id];
  }
  return { next, removed };
}

/** Add newly shipped versions, move every chain onto them, drop what's gone. */
export function bringToLatest(roster, store, now = Date.now()) {
  const { next: withNew, added } = addOfferedVersions(roster, store, now);
  const { next: moved, changes } = upgradeChains(withNew, store, now);
  const { next, removed } = pruneGone(moved, store, now);
  return { next, added, changes, removed };
}
