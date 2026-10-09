import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../json-store.mjs";
import { normalizeCapabilityManifest } from "./manifest.mjs";
import {
  inspectMcpServerTools,
  estimatePromptTokenContribution,
  mcpSchemaBytesFromToolsList,
} from "./mcp-schema.mjs";
import { capabilityScope } from "./skill-scope.mjs";

const DESTINATIONS = {
  skills: ["context", "skills"],
  frameworks: ["context", "framework"],
  plugins: ["harness", "plugins"],
  mcps: ["harness", "mcp"],
};

/**
 * A run's worker cwd. The launcher and the isolation canary both take it from
 * here: Claude reads project config from every directory above its cwd, so
 * whether a capsule leaks depends on where the cwd sits, and a canary probing
 * any other layout verifies something production never runs.
 */
export function capsuleContextDir(runRoot) {
  return path.join(runRoot, "context");
}

/** Prompt-facing types: skill / framework / plugin prose+metadata. */
const PROMPT_TYPES = new Set(["skills", "frameworks", "plugins"]);

function assertPathInsideRunRoot(candidate, runRoot, { label = "path" } = {}) {
  const fail = (code, message) => {
    const err = new Error(message);
    err.code = code;
    throw err;
  };
  if (!runRoot) fail("CONTENT_MANIFEST_REQUIRED", "CONTENT_MANIFEST_REQUIRED: runRoot required");
  const root = path.resolve(runRoot);
  const resolved = path.resolve(candidate);
  let rootReal = root;
  try {
    rootReal = fs.realpathSync.native(root);
  } catch {
    // The root may not exist yet when a caller validates a destination.
  }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    fail(
      "CONTENT_MANIFEST_ROOT_ESCAPE",
      `CONTENT_MANIFEST_ROOT_ESCAPE: ${label} ${resolved} outside runRoot ${root}`
    );
  }
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      fail("CONTENT_MANIFEST_SYMLINK", `CONTENT_MANIFEST_SYMLINK: ${label} ${resolved} is a symlink`);
    }
    const real = fs.realpathSync.native(resolved);
    if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
      fail(
        "CONTENT_MANIFEST_ROOT_ESCAPE",
        `CONTENT_MANIFEST_ROOT_ESCAPE: ${label} realpath ${real} outside runRoot ${rootReal}`
      );
    }
    return real;
  } catch (error) {
    if (error.code?.startsWith("CONTENT_MANIFEST_")) throw error;
    return resolved;
  }
}

function directoryByteSize(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (stat.isFile()) total += stat.size;
  }
  return total;
}

function materializedPromptBytes(runRoot, resolved) {
  let bytes = 0;
  for (const type of PROMPT_TYPES) {
    for (const rel of resolved[type] ?? []) {
      const full = path.join(runRoot, rel);
      if (!fs.existsSync(full)) continue;
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) bytes += directoryByteSize(full);
      else if (stat.isFile()) bytes += stat.size;
    }
  }
  return bytes;
}

/**
 * Measure canonical tools/list schema bytes for each materialized MCP config.
 * Never uses configuration-file byte length as "schema bytes".
 */
function materializedMcpSchemaBytes(runRoot, resolved, { spawnSyncFn } = {}) {
  let bytes = 0;
  let unavailable = 0;
  for (const rel of resolved.mcps ?? []) {
    const full = path.join(runRoot, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      unavailable += 1;
      continue;
    }
    let document;
    try {
      document = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      unavailable += 1;
      continue;
    }
    const servers = Object.values(document.mcpServers ?? {});
    if (!servers.length) {
      unavailable += 1;
      continue;
    }
    for (const server of servers) {
      const inspected = inspectMcpServerTools(server, { spawnSyncFn });
      if (!inspected) {
        unavailable += 1;
        continue;
      }
      bytes += inspected.schema_bytes;
    }
  }
  return { bytes, unavailable };
}

function isAllowedImmutableRuntimeCommand(command) {
  if (typeof command !== "string" || !command) return false;
  if (command === process.execPath) return true;
  try {
    if (path.isAbsolute(command) && fs.existsSync(command)) {
      const st = fs.lstatSync(command);
      if (st.isSymbolicLink()) return false;
      return fs.realpathSync.native(command) === fs.realpathSync.native(process.execPath);
    }
  } catch {
    return false;
  }
  return false;
}

function looksLikeFilesystemPath(arg) {
  if (typeof arg !== "string" || !arg) return false;
  if (path.isAbsolute(arg)) return true;
  if (arg.startsWith(".") || arg.includes("/") || arg.includes("\\")) return true;
  return /\.(mjs|cjs|js|json|py|sh|bin|wasm)$/i.test(arg);
}

/**
 * Copy capability-owned MCP runtime scripts into the capsule and rewrite args
 * to capsule-local paths. Only the detected node binary is allowed as an
 * external immutable command; arbitrary script paths are rejected or copied.
 */
function materializeMcpServerIntoCapsule(serverName, server, runRoot) {
  if (!isAllowedImmutableRuntimeCommand(server.command)) {
    const err = new Error(
      `MCP_RUNTIME_COMMAND_DENIED: ${serverName} command must be the node binary`
    );
    err.code = "MCP_RUNTIME_COMMAND_DENIED";
    throw err;
  }
  const next = {
    ...server,
    command: process.execPath,
    args: [...(server.args ?? [])],
  };
  const runtimeDir = path.join(runRoot, "harness", "mcp", serverName, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  for (let i = 0; i < next.args.length; i++) {
    const arg = next.args[i];
    if (!looksLikeFilesystemPath(arg)) continue;
    if (!path.isAbsolute(arg)) {
      const err = new Error(
        `MCP_RUNTIME_PATH_DENIED: ${serverName} arg must be absolute: ${arg}`
      );
      err.code = "MCP_RUNTIME_PATH_DENIED";
      throw err;
    }
    let st;
    try {
      st = fs.lstatSync(arg);
    } catch {
      const err = new Error(`MCP_RUNTIME_MISSING: ${arg}`);
      err.code = "MCP_RUNTIME_MISSING";
      throw err;
    }
    if (st.isSymbolicLink()) {
      const err = new Error(`MCP_RUNTIME_SYMLINK: ${arg}`);
      err.code = "MCP_RUNTIME_SYMLINK";
      throw err;
    }
    if (!st.isFile()) {
      const err = new Error(`MCP_RUNTIME_NONREGULAR: ${arg}`);
      err.code = "MCP_RUNTIME_NONREGULAR";
      throw err;
    }
    const dest = path.join(runtimeDir, path.basename(arg));
    if (path.resolve(arg) !== path.resolve(dest)) {
      fs.copyFileSync(arg, dest);
    }
    assertPathInsideRunRoot(dest, runRoot, { label: "mcp runtime" });
    fs.chmodSync(dest, 0o444);
    next.args[i] = dest;
  }
  return next;
}

export function materializeCapabilityCapsule({
  runRoot, specialistId, packages, exclusions = [], spawnSyncFn,
}) {
  const records = [];
  try {
    for (const item of packages) {
      const manifest = normalizeCapabilityManifest(JSON.parse(fs.readFileSync(
        path.join(item.packageDir, "capability.json"), "utf8"
      )), { packageDir: item.packageDir });
      // Last line of defence for the main-only layer: an assignment row can be
      // hand-edited, but nothing reaches a specialist without passing here.
      if (capabilityScope(manifest, item.packageDir) === "main") {
        throw new Error(`CAPABILITY_SCOPE_MAIN: ${item.package} is main-only and never enters a capsule`);
      }
      const resolved = { skills: [], plugins: [], mcps: [], frameworks: [] };
      for (const [type, entries] of Object.entries(manifest.provides)) {
        for (const rel of entries) {
          const prefix = `${type}/`;
          const typedRel = rel.startsWith(prefix)
            ? rel.slice(prefix.length)
            : path.join(item.id, rel);
          const destination = path.join(runRoot, ...DESTINATIONS[type], typedRel);
          if (fs.existsSync(destination)) {
            throw new Error(`CAPSULE_PATH_COLLISION: ${path.relative(runRoot, destination)}`);
          }
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          const source = path.join(item.packageDir, rel);
          const stat = fs.lstatSync(source);
          if (stat.isDirectory()) {
            fs.cpSync(source, destination, {
              recursive: true,
              dereference: false,
              errorOnExist: true,
            });
          } else {
            fs.copyFileSync(source, destination);
          }
          resolved[type].push(path.relative(runRoot, destination));
        }
      }
      // Rewrite MCP descriptors in-place so runtime scripts land under harness/mcp.
      for (const rel of resolved.mcps) {
        const full = path.join(runRoot, rel);
        const document = JSON.parse(fs.readFileSync(full, "utf8"));
        const servers = document.mcpServers ?? {};
        for (const [name, server] of Object.entries(servers)) {
          servers[name] = materializeMcpServerIntoCapsule(name, server, runRoot);
        }
        document.mcpServers = servers;
        fs.writeFileSync(full, `${JSON.stringify(document, null, 2)}\n`);
      }
      const promptBytes = materializedPromptBytes(runRoot, resolved);
      const promptEst = estimatePromptTokenContribution(promptBytes);
      const schema = materializedMcpSchemaBytes(runRoot, resolved, { spawnSyncFn });
      records.push({
        package: item.package, id: item.id, version: item.version,
        checksum: item.checksum, reason: item.reason, resolved,
        auto_invoke: manifest.auto_invoke ?? [],
        estimated_description_tokens: item.estimated_description_tokens ?? 0,
        mcp_tool_count: item.mcp_tool_count ?? 0,
        // Exact harness tokenizer unavailable — persist explicit estimate metadata only.
        estimated_prompt_token_contribution: promptEst.estimated_prompt_token_contribution,
        prompt_token_estimate_method: promptEst.prompt_token_estimate_method,
        mcp_schema_bytes: schema.bytes,
        mcp_schema_measurement: schema.unavailable
          ? "tools/list-partial-or-unavailable"
          : "tools/list-canonical-json",
        mcp_schema_unavailable_servers: schema.unavailable,
      });
    }
  } catch (error) {
    fs.rmSync(path.join(runRoot, "context"), { recursive: true, force: true });
    fs.rmSync(path.join(runRoot, "harness"), { recursive: true, force: true });
    throw error;
  }
  const record = {
    schema_version: 1,
    specialist_id: specialistId,
    packages: records,
    exclusions,
    totals: {
      estimated_description_tokens: records.reduce(
        (sum, item) => sum + item.estimated_description_tokens, 0),
      mcp_tool_count: records.reduce((sum, item) => sum + item.mcp_tool_count, 0),
      estimated_prompt_token_contribution: records.reduce(
        (sum, item) => sum + item.estimated_prompt_token_contribution, 0),
      mcp_schema_bytes: records.reduce(
        (sum, item) => sum + item.mcp_schema_bytes, 0),
    },
    prompt_token_estimate_method: "utf8_bytes_div_4_ceil",
  };
  atomicWriteJson(path.join(runRoot, "EFFECTIVE_CAPABILITIES.json"), record);
  return record;
}

/**
 * The skill invocation that opens a worker prompt, decided by the launcher
 * rather than left to the host agent's memory.
 *
 * A skill invoked as a command lands as the first user turn, right before the
 * task; the same text as an output style or system-prompt fragment sits far
 * from it, and in use changed the output far less. `invocation` comes from the harness
 * adapter, because the syntax is per CLI (`/name` in Claude Code). A harness
 * without one gets no prefix and a recorded reason, never a guessed syntax.
 */
export function autoInvokePrefix(effective, invocation) {
  const names = [...new Set((effective?.packages ?? []).flatMap((item) => item.auto_invoke ?? []))];
  if (names.length === 0) return { skills: [], prefix: "", skipped: null };
  if (names.length > 1) {
    throw new Error(`AUTO_INVOKE_CONFLICT: ${names.join(", ")} — a prompt opens with one skill invocation; disable all but one for this specialist`);
  }
  if (typeof invocation !== "function") {
    return { skills: names, prefix: "", skipped: "harness has no skill invocation syntax" };
  }
  return { skills: names, prefix: `${invocation(names[0])}\n\n`, skipped: null };
}

export function buildStrictMcpConfig(effective, runRoot) {
  const mcpServers = {};
  for (const item of effective.packages) {
    for (const rel of item.resolved.mcps) {
      const document = JSON.parse(fs.readFileSync(path.join(runRoot, rel), "utf8"));
      for (const [name, server] of Object.entries(document.mcpServers ?? {})) {
        if (mcpServers[name]) {
          throw new Error(`MCP_NAME_COLLISION: ${name}`);
        }
        // Descriptors should already be capsule-local from materialization;
        // re-bind defensively so hand-built capsules still close the world.
        mcpServers[name] = materializeMcpServerIntoCapsule(name, server, runRoot);
      }
    }
  }
  return { mcpServers };
}

export { mcpSchemaBytesFromToolsList } from "./mcp-schema.mjs";

/**
 * Tool allowlist entries for every MCP server a capsule materialized.
 *
 * `tools` may sit on a server or beside `mcpServers` as a shared list. The
 * shared form can only be attributed when the descriptor declares a single
 * server: with two servers and one flat list, handing it to both would grant
 * each of them the other's tool names.
 */
export function collectCapsuleMcpTools(effective, runRoot) {
  const mcpToolsByServer = {};
  const mcpToolNames = [];
  for (const item of effective.packages ?? []) {
    for (const rel of item.resolved?.mcps ?? []) {
      const document = JSON.parse(fs.readFileSync(path.join(runRoot, rel), "utf8"));
      const entries = Object.entries(document.mcpServers ?? {});
      const sharedTools =
        entries.length === 1 && Array.isArray(document.tools) ? document.tools : [];
      for (const [name, server] of entries) {
        const tools = Array.isArray(server?.tools) ? server.tools : sharedTools;
        mcpToolsByServer[name] = tools;
        for (const tool of tools) {
          mcpToolNames.push(`mcp__${name}__${String(tool).replace(/-/g, "_")}`);
        }
      }
    }
  }
  return { mcpToolNames, mcpToolsByServer };
}
