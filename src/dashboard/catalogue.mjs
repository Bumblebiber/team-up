import { parseChainEntry } from "../roster/chain.mjs";
import { cliModelFor } from "../roster/config.mjs";
import { splitVersion, compareVersions, excludedKey } from "../roster/latest.mjs";

/**
 * The Models tab: per provider, every model it offers, and which of them the
 * roster carries. A checked row is a roster model the chain dropdowns offer;
 * unchecking one removes it and keeps it out — later versions included.
 *
 * Providers are who gets paid. A subscription provider is one CLI whose scan
 * is its list (Anthropic = claude). An API-key provider is a prefix in the
 * opencode scan (`openrouter/…`, `minimax/…`). opencode and hermes are CLIs,
 * not providers; `opencode/…` (its own free tier) is not listed.
 */
const SUBSCRIPTION_LABELS = { claude: "Anthropic", codex: "OpenAI", cursor: "Cursor", gemini: "Google" };
const API_LABELS = { openrouter: "OpenRouter", minimax: "MiniMax", deepseek: "DeepSeek", moonshotai: "Moonshot", zai: "Z.AI" };
const API_CLI = "opencode";
const API_ACCOUNT = "api";

const own = (obj, key) => !!obj && Object.hasOwn(obj, key);

/** Roster ids that run `cliId` on `cli`. */
function rosterIdsFor(roster, cli, cliId) {
  return Object.entries(roster?.models || {})
    .filter(([id, spec]) => spec?.cli?.includes(cli) && cliModelFor(roster, id, cli) === cliId)
    .map(([id]) => id);
}

export function buildCatalogueView(roster, store) {
  const groups = new Map();
  const group = (tab, id, label) => {
    const key = `${tab}:${id}`;
    if (!groups.has(key)) groups.set(key, { tab, id, label, models: [] });
    return groups.get(key);
  };
  const matched = new Set();
  const addRow = (g, cli, cliId, extra = {}) => {
    const ids = rosterIdsFor(roster, cli, cliId);
    for (const id of ids) matched.add(`${id}\0${cli}`);
    g.models.push({ cli, cli_id: cliId, roster_ids: ids, checked: ids.length > 0, ...extra });
  };

  const accounts = roster?.accounts || {};
  for (const [account, spec] of Object.entries(accounts)) {
    if (spec?.kind !== "subscription") continue;
    const g = group("subscription", account, SUBSCRIPTION_LABELS[account] || account);
    for (const m of store?.clis?.[account]?.models || []) {
      addRow(g, account, m.cli_id, { name: m.version || m.display_name || m.cli_id });
    }
  }
  for (const m of store?.clis?.[API_CLI]?.models || []) {
    const slash = m.cli_id.indexOf("/");
    const prefix = slash > 0 ? m.cli_id.slice(0, slash) : null;
    if (!prefix || prefix === "opencode") continue;
    addRow(group("api", prefix, API_LABELS[prefix] || prefix), API_CLI, m.cli_id, {
      name: m.cli_id.slice(slash + 1),
    });
  }
  // Roster models no scan lists (hermes has none; a disabled account still
  // counts) — shown checked under who bills them, so every chain option can
  // be unchecked here.
  for (const [id, spec] of Object.entries(roster?.models || {})) {
    for (const cli of spec?.cli || []) {
      if (matched.has(`${id}\0${cli}`)) continue;
      const sub = accounts[spec.account]?.kind === "subscription";
      const gid = sub ? spec.account : spec.provider || spec.account || "other";
      const g = group(sub ? "subscription" : "api", gid,
        (sub ? SUBSCRIPTION_LABELS : API_LABELS)[gid] || gid);
      g.models.push({ cli, cli_id: cliModelFor(roster, id, cli), roster_ids: [id], checked: true, unscanned: true });
    }
  }
  const list = [...groups.values()];
  for (const g of list) g.models.sort((a, b) => b.checked - a.checked || a.cli_id.localeCompare(b.cli_id));
  return { providers: list.sort((a, b) => a.label.localeCompare(b.label)) };
}

/** Where a newly checked model inherits tier, reasoning and limits from. */
function familySibling(roster, cli, cliId) {
  const { family, version } = splitVersion(cliId);
  if (!version) return null;
  let best = null;
  for (const [other, spec] of Object.entries(roster.models || {})) {
    if (!spec?.cli?.includes(cli)) continue;
    const s = splitVersion(cliModelFor(roster, other, cli));
    if (s.family !== family || !s.version) continue;
    if (!best || compareVersions(s.version, best.version) > 0) best = { spec, version: s.version };
  }
  return best?.spec ?? null;
}

/** Does this chain entry lose its model when `cli` leaves `ids`? */
function dangles(roster, e, cli, ids) {
  return ids.includes(e.model) && (e.cli === cli || (!e.cli && roster.models[e.model].cli.length === 1));
}

/** Roles with a chain entry that loses its model when `cli` leaves `ids`. */
export function affectedRoles(roster, cli, ids) {
  return Object.entries(roster.roles || {})
    .filter(([, spec]) => (spec?.chain || []).some((raw) => {
      try { return dangles(roster, parseChainEntry(raw), cli, ids); } catch { return false; }
    }))
    .map(([role]) => role);
}

/**
 * Check or uncheck one (cli, cli_id) row.
 * - on: adds a roster model (copying a same-family sibling's tier/reasoning)
 *   and lifts the exclusion.
 * - off: drops the CLI from every roster model that runs it there, deletes a
 *   model left with no CLI, and records the exclusion. Chain entries that
 *   would dangle need `resolve`: `"strike"` or `{ model, cli }` to replace
 *   them; without it the edit throws with `roles` set.
 */
export function applyCatalogueToggle(roster, { cli, cli_id: cliId, on, provider, resolve } = {}) {
  if (typeof cli !== "string" || !cli || typeof cliId !== "string" || !cliId) {
    throw new Error("cli and cli_id required");
  }
  const next = structuredClone(roster);
  next.models ??= {};
  const excluded = new Set(next.models_excluded || []);
  if (on) {
    excluded.delete(excludedKey(cli, cliId));
    if (!rosterIdsFor(next, cli, cliId).length) {
      let id = cliId.replaceAll(":", "-");
      if (own(next.models, id)) id = `${cli}-${id}`;
      const sib = familySibling(next, cli, cliId);
      const { price, notes, $comment, strengths, weaknesses, cli_model, ...base } = sib ? structuredClone(sib) : {};
      const subscription = next.accounts?.[cli]?.kind === "subscription";
      next.models[id] = {
        ...base,
        provider: base.provider || provider || cli,
        account: base.account || (subscription ? cli : API_ACCOUNT),
        cli: [cli],
        ...(id !== cliId ? { cli_model: cliId } : {}),
      };
    }
  } else {
    const ids = rosterIdsFor(next, cli, cliId);
    const roles = affectedRoles(next, cli, ids);
    if (roles.length && resolve == null) {
      const err = new Error(`still in the chain of ${roles.join(", ")}`);
      err.roles = roles;
      throw err;
    }
    const repl = resolve === "strike" ? null : resolve;
    if (roles.length && repl && (!own(next.models, repl.model) || !next.models[repl.model].cli?.includes(repl.cli)
      || (ids.includes(repl.model) && repl.cli === cli))) {
      throw new Error("replacement must be another roster model on one of its CLIs");
    }
    for (const role of roles) {
      const chain = [];
      for (const raw of next.roles[role].chain) {
        let e;
        try { e = parseChainEntry(raw); } catch { chain.push(raw); continue; }
        if (!dangles(next, e, cli, ids)) chain.push(raw);
        else if (repl) chain.push(`${repl.cli}:${repl.model}`);
      }
      const deduped = [...new Map(chain.map((c) => [JSON.stringify(c), c])).values()];
      if (!deduped.length) throw new Error(`the chain of ${role} would be empty — pick a replacement`);
      next.roles[role].chain = deduped;
    }
    for (const id of ids) {
      next.models[id].cli = next.models[id].cli.filter((c) => c !== cli);
      if (!next.models[id].cli.length) delete next.models[id];
    }
    excluded.add(excludedKey(cli, cliId));
  }
  if (excluded.size) next.models_excluded = [...excluded].sort();
  else delete next.models_excluded;
  return next;
}
