import { pick, parseChainEntry } from "../roster/chain.mjs";
import { cliModelFor } from "../roster/config.mjs";
import { cellStatus, addOfferedVersions } from "../roster/latest.mjs";

/**
 * Roles, their chains, and the roster settings around them — the one place
 * the dashboard writes `roles` and the handful of top-level switches.
 *
 * Edits here write role chains without changing model selection policy.
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

function chainView(roster, store, chain, now) {
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
      ? cellStatus(roster, store, cli, parsed.model, now)
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
        protected: own(PROTECTED_ROLES, role) ? PROTECTED_ROLES[role] : null,
        effort: spec?.effort ?? null,
        chain: chainView(roster, store, spec?.chain || [], now),
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
  return { roles, models, addable, efforts: ROLE_EFFORTS, clis: Object.keys(roster?.clis || {}).sort() };
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

// Roles team-up's own code asks `pick` for. Deleting one breaks that caller
// at its next run, so the dashboard refuses; edit their chains instead.
export const PROTECTED_ROLES = {
  implementer: "the insights job's fix runs and the usage-spender's implement runs",
  reviewer: "the usage-spender's reviews and audits",
  researcher: "the usage-spender's research tasks",
  planner: "the usage-spender's triage runs",
  observer: "the run observer that watches every worker",
};

// Role-wide effort: the generic levels every CLI maps (config.mjs EFFORT_ORDER
// minus the spellings only one CLI knows). A chain entry's own effort wins.
export const ROLE_EFFORTS = ["low", "medium", "high", "max"];

/**
 * One edit per call:
 * - `{ role, chain }` creates or replaces a chain
 * - `{ role, effort }` sets the role-wide effort; null or "" clears it
 * - `{ role, delete: true }` removes it, refused while a specialist runs on it
 */
export function applyRoleEdit(roster, { role, chain, effort, delete: remove } = {}) {
  if (!ROLE_NAME.test(String(role || ""))) {
    throw new Error("role name: lowercase letters, digits, . _ - (max 64)");
  }
  const next = structuredClone(roster);
  next.roles ??= {};
  if (remove) {
    if (!own(next.roles, role)) throw new Error(`unknown role: ${role}`);
    if (own(PROTECTED_ROLES, role)) throw new Error(`${role} is used by ${PROTECTED_ROLES[role]} — change its chain instead`);
    const users = Object.entries(next.specialists || {}).filter(([, s]) => s?.role === role).map(([id]) => id);
    if (users.length) throw new Error(`${users.join(", ")} run on ${role} — reassign them first`);
    delete next.roles[role];
    return next;
  }
  if (chain !== undefined) {
    next.roles[role] = {
      ...(own(next.roles, role) ? next.roles[role] : {}),
      chain: normalizeChain(next, chain),
    };
    return next;
  }
  if (effort !== undefined) {
    if (!own(next.roles, role)) throw new Error(`unknown role: ${role}`);
    if (effort === null || effort === "") delete next.roles[role].effort;
    else if (ROLE_EFFORTS.includes(effort)) next.roles[role].effort = effort;
    else throw new Error(`effort must be one of ${ROLE_EFFORTS.join(", ")}`);
    return next;
  }
  throw new Error("edit names no field (expected chain, effort or delete)");
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
