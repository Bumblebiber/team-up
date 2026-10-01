import { parseChainEntry, chainHolders } from "../roster/chain.mjs";
import { aliasFor, fillEffort, groupEfforts, effortSpec, EFFORT_IN_NAME } from "../roster/config.mjs";
import { splitVersion, compareVersions, excludedKey } from "../roster/latest.mjs";

/**
 * The Models tab: per provider, every model it offers, and which of them the
 * roster carries. A checked row is a roster model the chain dropdowns offer;
 * unchecking one removes it and records the (cli, id) in `models_excluded`,
 * so the newest-version sweep and apply-scores never add that id back. A
 * newer version still arrives through an older sibling that stays checked.
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

/** Roster ids that run `cliId` (for cursor: the effort template) on `cli`. */
function rosterIdsFor(roster, cli, cliId) {
  return Object.entries(roster?.models || {})
    .filter(([id, spec]) => spec?.cli?.includes(cli) && aliasFor(spec, id, cli) === cliId)
    .map(([id]) => id);
}

/** What a CLI's scan offers, one entry per model: cursor's efforts folded. */
function offeredEntries(store, cli) {
  const ids = (store?.clis?.[cli]?.models || []).map((m) => m.cli_id);
  return EFFORT_IN_NAME.has(cli) ? groupEfforts(ids) : ids.map((id) => ({ id, base: id }));
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
    const names = new Map((store?.clis?.[account]?.models || []).map((m) => [m.cli_id, m.version || m.display_name]));
    for (const e of offeredEntries(store, account)) {
      addRow(g, account, e.id, { name: names.get(e.id) || e.base, ...(e.efforts?.length ? { efforts: e.efforts } : {}) });
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
      g.models.push({ cli, cli_id: aliasFor(spec, id, cli), roster_ids: [id], checked: true, unscanned: true });
    }
  }
  const list = [...groups.values()];
  for (const g of list) g.models.sort((a, b) => b.checked - a.checked || a.cli_id.localeCompare(b.cli_id));
  return { providers: list.sort((a, b) => a.label.localeCompare(b.label)) };
}

/** Where a newly checked model inherits reasoning and limits from. */
function familySibling(roster, cli, cliId) {
  const { family, version } = splitVersion(cliId);
  if (!version) return null;
  let best = null;
  for (const [other, spec] of Object.entries(roster.models || {})) {
    if (!spec?.cli?.includes(cli)) continue;
    const s = splitVersion(fillEffort(aliasFor(spec, other, cli), null));
    if (s.family !== family || !s.version) continue;
    if (!best || compareVersions(s.version, best.version) > 0) best = { spec, version: s.version };
  }
  return best?.spec ?? null;
}

/** Does this chain entry lose its model when `cli` leaves `ids`? */
function dangles(roster, e, cli, ids) {
  return ids.includes(e.model) && (e.cli === cli || (!e.cli && roster.models[e.model].cli.length === 1));
}

/** Chain holders (see `chainHolders`) with an entry that loses its model when `cli` leaves `ids`. */
export function affectedRoles(roster, cli, ids) {
  return chainHolders(roster)
    .filter(([, spec]) => (spec?.chain || []).some((raw) => {
      try { return dangles(roster, parseChainEntry(raw), cli, ids); } catch { return false; }
    }))
    .map(([label]) => label);
}

/**
 * Check or uncheck one (cli, cli_id) row.
 * - on: adds a roster model (copying a same-family sibling's reasoning)
 *   and lifts the exclusion.
 * - off: drops the CLI from every roster model that runs it there, deletes a
 *   model left with no CLI, and records the exclusion. Chain entries that
 *   would dangle need `resolve`: `"strike"` or `{ model, cli }` to replace
 *   them; without it the edit throws with `roles` set.
 */
export function applyCatalogueToggle(roster, { cli, cli_id: cliId, on, provider, resolve } = {}, store = null) {
  if (typeof cli !== "string" || !own(roster?.clis, cli) || typeof cliId !== "string" || !cliId) {
    throw new Error("a roster cli and a cli_id required");
  }
  // Only what the CLI's scan lists can be checked in; a CLI without a scan
  // (hermes) has nothing to check, only roster rows to uncheck.
  const entry = store ? offeredEntries(store, cli).find((e) => e.id === cliId) : null;
  if (on && store && !entry) throw new Error(`${cli} does not offer ${cliId}`);
  const next = structuredClone(roster);
  next.models ??= {};
  const excluded = new Set(next.models_excluded || []);
  if (on) {
    excluded.delete(excludedKey(cli, cliId));
    if (!rosterIdsFor(next, cli, cliId).length) {
      const templated = cliId.includes("{effort}");
      let id = fillEffort(cliId, null).replaceAll(":", "-");
      if (own(next.models, id)) id = `${cli}-${id}`;
      const sib = familySibling(next, cli, fillEffort(cliId, null));
      const { price, notes, $comment, strengths, weaknesses, cli_model, ...base } = sib ? structuredClone(sib) : {};
      if (templated) {
        // The effort steps are this model's, not its sibling's.
        delete base.reasoning;
        delete base.effort;
        delete base.efforts;
        if (!entry?.efforts?.length) throw new Error(`no effort steps known for ${cliId} — rescan`);
      }
      const subscription = next.accounts?.[cli]?.kind === "subscription";
      next.models[id] = {
        ...base,
        provider: base.provider || provider || cli,
        account: base.account || (subscription ? cli : API_ACCOUNT),
        cli: [cli],
        ...(id !== cliId ? { cli_model: cliId } : {}),
        ...(templated ? effortSpec(entry) : {}),
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
    const holders = new Map(chainHolders(next));
    for (const role of roles) {
      const holder = holders.get(role);
      const chain = [];
      for (const raw of holder.chain) {
        let e;
        try { e = parseChainEntry(raw); } catch { chain.push(raw); continue; }
        if (!dangles(next, e, cli, ids)) chain.push(raw);
        else if (repl) chain.push(`${repl.cli}:${repl.model}`);
      }
      const deduped = [...new Map(chain.map((c) => [JSON.stringify(c), c])).values()];
      if (!deduped.length) throw new Error(`the chain of ${role} would be empty — pick a replacement`);
      holder.chain = deduped;
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
