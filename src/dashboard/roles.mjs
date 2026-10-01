import { pick, parseChainEntry } from "../roster/chain.mjs";
import { cliModelFor } from "../roster/config.mjs";
import { cellStatus, addOfferedVersions } from "../roster/latest.mjs";

/**
 * Roles, their chains, and the roster settings around them — the one place
 * the dashboard writes `roles` and the handful of top-level switches.
 *
 * `apply-scores` rewrites a chain's head every week unless the role carries
 * `pin_head`, so a chain saved here pins its head by default: a hand edit
 * that silently reverts on Monday is worse than no editor.
 */

const ROLE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Own keys only: `constructor` is a valid role name and `__proto__` an object
// key, and neither may resolve through the prototype chain.
const own = (obj, key) => !!obj && Object.hasOwn(obj, key);

/**
 * `claude-opus` + scan says `opus` is "Opus 5.5" → `claude-opus-5.5`. An id
 * that already carries a version, or a model the scan never named, stays as is.
 */
export function modelLabel(roster, store, id, cli = roster?.models?.[id]?.cli?.[0]) {
  if (!cli || /-\d/.test(id)) return id;
  const sent = cliModelFor(roster, id, cli);
  const version = store?.clis?.[cli]?.models?.find((m) => m.cli_id === sent)?.version;
  const number = version?.match(/\d+(?:\.\d+)*/)?.[0];
  return number ? `${id}-${number}` : id;
}

function chainView(roster, store, chain) {
  return chain.map((raw) => {
    let parsed;
    try {
      parsed = parseChainEntry(raw);
    } catch (e) {
      return { invalid: String(e.message) };
    }
    const cli = parsed.cli ?? roster.models?.[parsed.model]?.cli?.[0] ?? null;
    const known = !!roster.models?.[parsed.model];
    const { state, newest } = cli && known
      ? cellStatus(roster, store, cli, parsed.model)
      : { state: known ? "unknown" : "missing", newest: null };
    return {
      cli,
      model: parsed.model,
      effort: parsed.effort,
      pinned: typeof raw === "object" && raw?.pinned === true,
      label: modelLabel(roster, store, parsed.model, cli),
      state,
      newest,
    };
  });
}

export function buildRolesView(roster, usage, store, now = Date.now()) {
  const roles = Object.entries(roster?.roles || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, spec]) => {
      const result = pick({ roster, usage, role, now });
      return {
        role,
        pin_head: spec?.pin_head === true,
        effort: spec?.effort ?? null,
        chain: chainView(roster, store, spec?.chain || []),
        pick: result.model
          ? { cli: result.cli, model: result.model, effort: result.effort ?? null,
              label: modelLabel(roster, store, result.model, result.cli) }
          : null,
        skipped: result.skipped || [],
      };
    });
  const models = Object.entries(roster?.models || {})
    .map(([id, spec]) => ({
      id,
      label: modelLabel(roster, store, id),
      clis: Array.isArray(spec?.cli) ? spec.cli : [],
      account: spec?.account ?? null,
      // What the effort picker offers: the CLI values this model's reasoning
      // map uses, strongest first, and the default it runs at without one.
      // A cursor template also offers every step its scan listed.
      efforts: [...new Set([...["max", "high", "medium", "low"]
        .map((level) => spec?.reasoning?.[level]), ...(Array.isArray(spec?.efforts) ? spec.efforts : [])]
        .filter((v) => typeof v === "string" && v))],
      default_effort: spec?.effort ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  // Versions a CLI ships that the roster does not know yet; the upgrade
  // button adds them before it moves the chains.
  const addable = addOfferedVersions(roster, store, now).added;
  return { roles, models, addable, clis: Object.keys(roster?.clis || {}).sort() };
}

/** Chain entries as the browser sends them → what roster.json stores. */
export function normalizeChain(roster, chain) {
  if (!Array.isArray(chain) || chain.length === 0) throw new Error("chain must name at least one model");
  return chain.map((entry, i) => {
    const { model, cli, effort, pinned } = entry || {};
    const spec = own(roster.models, model) ? roster.models[model] : null;
    if (!spec) throw new Error(`chain[${i}]: unknown model ${model}`);
    if (!cli || !spec.cli?.includes(cli)) throw new Error(`chain[${i}]: ${model} does not run on ${cli}`);
    if (effort != null && typeof effort !== "string") throw new Error(`chain[${i}]: effort must be a string`);
    if (!effort && !pinned) return `${cli}:${model}`;
    return { model, cli, ...(effort ? { effort } : {}), ...(pinned ? { pinned: true } : {}) };
  });
}

/**
 * One edit per call:
 * - `{ role, chain }` creates or replaces; pins the head unless `pin_head: false`
 * - `{ role, pin_head }` flips the pin alone
 * - `{ role, delete: true }` removes it, refused while a specialist runs on it
 */
export function applyRoleEdit(roster, { role, chain, pin_head, delete: remove } = {}) {
  if (!ROLE_NAME.test(String(role || ""))) {
    throw new Error("role name: lowercase letters, digits, . _ - (max 64)");
  }
  const next = structuredClone(roster);
  next.roles ??= {};
  if (remove) {
    if (!own(next.roles, role)) throw new Error(`unknown role: ${role}`);
    const users = Object.entries(next.specialists || {}).filter(([, s]) => s?.role === role).map(([id]) => id);
    if (users.length) throw new Error(`${users.join(", ")} run on ${role} — reassign them first`);
    delete next.roles[role];
    return next;
  }
  if (chain !== undefined) {
    next.roles[role] = {
      ...(own(next.roles, role) ? next.roles[role] : {}),
      chain: normalizeChain(next, chain),
      pin_head: pin_head !== false,
    };
    return next;
  }
  if (pin_head !== undefined) {
    if (!own(next.roles, role)) throw new Error(`unknown role: ${role}`);
    if (pin_head) next.roles[role].pin_head = true;
    else delete next.roles[role].pin_head;
    return next;
  }
  throw new Error("edit names no field (expected chain, pin_head or delete)");
}

/**
 * A specialist runs on a role's chain (`{ id, role }`) or a chain of its own
 * (`{ id, chain }`, browser shape as for roles). Neither clears the
 * assignment, and an unassigned specialist does not launch.
 */
export function applySpecialistAssignment(roster, { id, role, chain } = {}) {
  if (role != null && chain != null) throw new Error("a role or a chain, not both");
  const next = structuredClone(roster);
  next.specialists ??= {};
  if (role != null) {
    if (!own(next.roles, role)) throw new Error(`unknown role: ${role}`);
    next.specialists[id] = { role };
  } else if (chain != null) {
    next.specialists[id] = { chain: normalizeChain(next, chain) };
  } else {
    delete next.specialists[id];
  }
  if (!Object.keys(next.specialists).length) delete next.specialists;
  return next;
}

// ── Settings ───────────────────────────────────────────────────────────────
// Whitelisted paths only. `clis[*].cmd` is deliberately absent: a command
// template edited from a browser is an arbitrary-execution lever.
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isUnit = (v) => isNum(v) && v >= 0 && v <= 1;
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isBool = (v) => typeof v === "boolean";
const isStrList = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s);

const SETTINGS = [
  [/^accounts\.([^.]+)\.enabled$/, isBool, (r, [, id]) => own(r.accounts, id)],
  [/^accounts\.([^.]+)\.remaining$/, isNum, (r, [, id]) => own(r.accounts, id) && r.accounts[id].kind === "credit"],
  [/^limits\.(warn_at|handoff_at)$/, (v) => isUnit(v) && v > 0],
  [/^subscriptions$/, isStrList, (r, _m, v) => v.every((cli) => own(r.clis, cli))],
  [/^usage_watcher\.tick_sec$/, isPosInt],
  [/^usage_watcher\.intervals\.(idle_min|active_min|busy_min|idle_heartbeat_hours)$/, isPosInt],
];

export function applySettingsEdit(roster, { path: setting, value } = {}) {
  const rule = SETTINGS.find(([re]) => re.test(String(setting || "")));
  if (!rule) throw new Error(`not editable here: ${setting}`);
  const [re, valid, exists = () => true] = rule;
  const match = String(setting).match(re);
  if (!valid(value) || !exists(roster, match, value)) {
    throw new Error(`invalid value for ${setting}: ${JSON.stringify(value)}`);
  }
  const next = structuredClone(roster);
  const keys = setting.split(".");
  let node = next;
  for (const key of keys.slice(0, -1)) node = node[key] ??= {};
  node[keys.at(-1)] = value;
  return next;
}

export function buildSettingsView(roster) {
  const accounts = Object.fromEntries(Object.entries(roster?.accounts || {}).map(([id, a]) =>
    [id, { kind: a.kind, enabled: a.enabled, ...(a.kind === "credit" ? { remaining: a.remaining ?? null } : {}),
      ...(a.$comment ? { comment: a.$comment } : {}) }]));
  return {
    accounts,
    limits: { warn_at: roster?.limits?.warn_at ?? null, handoff_at: roster?.limits?.handoff_at ?? null },
    subscriptions: roster?.subscriptions || [],
    usage_watcher: { tick_sec: roster?.usage_watcher?.tick_sec ?? null,
      intervals: roster?.usage_watcher?.intervals || {} },
    clis: Object.keys(roster?.clis || {}).sort(),
    roles: Object.keys(roster?.roles || {}).sort(),
  };
}
