import os from "node:os";
import path from "node:path";

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
  // `Write` is unconditional: the mailbox is how a specialist reports at all,
  // and closing it means creating RESULT.json and setting STATUS. Deriving it
  // from `writes` left a read-only researcher able to finish the work and
  // unable to hand it over — she said so herself and returned the report as
  // terminal output nobody was watching. `writes` governs the project, not the
  // specialist's own output channel; which paths are writable is the sandbox's
  // job, and the mailbox is bound writable there for every call type.
  //
  // ToolSearch and Skill are on the floor for the same kind of reason: neither
  // writes nor reaches the network, and a `--tools` list without Skill silently
  // disables every skill the capsule just materialized.
  const tools = ["Read", "Glob", "Grep", "ToolSearch", "Skill", "Write"];
  // `Edit` is the one that mutates existing files, so it stays gated.
  if (permissions.writes === true || permissions.writes === "delegated_only") {
    tools.push("Edit");
  }
  if (permissions.network === true) tools.push("WebFetch", "WebSearch");
  return tools;
}

/**
 * Files whose contents no specialist has a reason to see. Each is mode 600 and
 * every specialist runs as the same UID, so file modes do not separate them —
 * the tool layer has to.
 *
 * The realistic failure is not theft but quotation. Reporting file contents is
 * exactly what a scout is for, so a specialist that reads a credential file may
 * repeat it in RESULT.md, and RESULT.md gets committed. No malice required.
 *
 * A `Read(...)` deny rule is enforced where the file is opened, not in the
 * `Read` tool, so it also stops `Grep` from returning the matching line — which
 * is where a token would actually surface. Verified against claude 2.x: an
 * exact path and a `/**` subtree both refuse, siblings stay readable, and a
 * forced `Grep` on a denied path comes back `is_error: true`.
 */
export function credentialDenyPaths(homeDir) {
  const home = homeDir || os.homedir();
  return [
    path.join(home, ".mcp.json"),
    path.join(home, ".npmrc"),
    path.join(home, ".netrc"),
    path.join(home, ".git-credentials"),
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".config", "gh", "**"),
    path.join(home, ".hermes", "secrets", "**"),
    path.join(home, ".ssh", "**"),
    path.join(home, ".aws", "**"),
    path.join(home, ".gnupg", "**"),
  ];
}

/**
 * The same paths as claude-CLI permission rules. An absolute path is written
 * with a leading `//` in that syntax, hence the extra slash.
 */
export function credentialDenyRules(homeDir) {
  return credentialDenyPaths(homeDir).map((p) => `Read(/${p})`);
}
