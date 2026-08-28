/**
 * Permission intersection: request may only reduce the approved manifest permissions.
 */

const FS_RANK = {
  none: 0,
  project_readonly: 1,
  project: 2,
  home: 3,
};

const WRITES_RANK = {
  false: 0,
  delegated_only: 1,
  true: 2,
};

function rankFs(v) {
  if (v === false || v == null) return FS_RANK.none;
  return FS_RANK[v] ?? -1;
}

function rankWrites(v) {
  if (v === false || v == null) return WRITES_RANK.false;
  if (v === true) return WRITES_RANK.true;
  return WRITES_RANK[v] ?? -1;
}

function intersectAllowlist(approved, requested) {
  const a = Array.isArray(approved) ? approved : [];
  if (requested == null) return [...a];
  if (!Array.isArray(requested)) {
    throw new Error("permission allowlist must be an array");
  }
  const allowed = new Set(a);
  const out = [];
  for (const item of requested) {
    if (!allowed.has(item)) {
      throw new Error(`permission escalation: undeclared allowlist entry ${item}`);
    }
    out.push(item);
  }
  return out;
}

/**
 * @param {object} approved - manifest.permissions (+ optional capabilities allowlists)
 * @param {object|null} requested - caller permissions overlay
 * @param {{ capabilities?: object }} [ctx]
 */
export function intersectPermissions(approved, requested, ctx = {}) {
  if (!approved || typeof approved !== "object") {
    throw new Error("approved permissions required");
  }
  const req = requested && typeof requested === "object" ? requested : {};

  // Network: may only stay false or become false; never enable if approved false
  let network = approved.network === true;
  if (Object.prototype.hasOwnProperty.call(req, "network")) {
    if (req.network === true && approved.network !== true) {
      throw new Error("permission escalation: network");
    }
    network = Boolean(req.network) && approved.network === true;
  }

  // Filesystem scope: may only shrink
  let filesystem = approved.filesystem;
  if (Object.prototype.hasOwnProperty.call(req, "filesystem")) {
    const ar = rankFs(approved.filesystem);
    const rr = rankFs(req.filesystem);
    if (rr < 0 || ar < 0) throw new Error("invalid filesystem permission");
    if (rr > ar) throw new Error("permission escalation: filesystem scope");
    filesystem = req.filesystem;
  }

  // Writes: may only shrink
  let writes = approved.writes;
  if (Object.prototype.hasOwnProperty.call(req, "writes")) {
    const ar = rankWrites(approved.writes);
    const rr = rankWrites(req.writes);
    if (rr < 0 || ar < 0) throw new Error("invalid writes permission");
    if (rr > ar) throw new Error("permission escalation: writes");
    writes = req.writes;
  }

  const commands = intersectAllowlist(approved.commands, req.commands);

  const caps = ctx.capabilities || {};
  const tools = intersectAllowlist(caps.tools, req.tools);
  const mcps = intersectAllowlist(caps.mcps, req.mcps);
  const frameworks = intersectAllowlist(caps.frameworks, req.frameworks);

  // Reject unknown escalation keys that expand beyond approved
  for (const key of Object.keys(req)) {
    if (!["network", "filesystem", "writes", "commands", "tools", "mcps", "frameworks"].includes(key)) {
      // ignore unknown for forward compat unless they look like expansions
      if (req[key] === true && approved[key] !== true) {
        throw new Error(`permission escalation: ${key}`);
      }
    }
  }

  return {
    filesystem,
    writes,
    network,
    commands,
    ...(tools.length || req.tools ? { tools } : {}),
    ...(mcps.length || req.mcps ? { mcps } : {}),
    ...(frameworks.length || req.frameworks ? { frameworks } : {}),
  };
}

export function assertCallTypeAllowed(callType, manifest) {
  const allowed = manifest?.call_types;
  if (!Array.isArray(allowed) || !allowed.includes(callType)) {
    throw new Error(`call_type not allowed by manifest: ${callType}`);
  }
}

/**
 * Builtin tools a specialist may hold, derived from its approved permissions.
 * Without this every specialist gets the adapter default — including `Write`
 * for a read-only researcher, and no web tool for one whose manifest asks for
 * the network. The sandbox still enforces the filesystem side; this keeps the
 * tool list from advertising what the manifest did not grant.
 *
 * Lives here rather than beside the launcher because the authoritative launch
 * rebuilds its argv from the persisted descriptor, in a module the launcher
 * imports — deriving it in only one of those two places is how a read-only
 * researcher ended up holding `Write`.
 */
export function builtinsForPermissions(permissions = {}) {
  // ToolSearch and Skill grant neither writes nor network, and a capsule that
  // materialized skills has no way to invoke them without Skill on the list.
  const tools = ["Read", "Glob", "Grep", "ToolSearch", "Skill"];
  if (permissions.writes === true || permissions.writes === "delegated_only") {
    tools.push("Edit", "Write");
  }
  if (permissions.network === true) tools.push("WebFetch", "WebSearch");
  return tools;
}
