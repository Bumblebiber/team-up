import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../json-store.mjs";
import { normalizeCapabilityManifest } from "./manifest.mjs";
import {
  inspectMcpServerTools,
  estimatePromptTokenContribution,
  mcpSchemaBytesFromToolsList,
} from "./mcp-schema.mjs";

const DESTINATIONS = {
  skills: ["context", "skills"],
  frameworks: ["context", "framework"],
  plugins: ["harness", "plugins"],
  mcps: ["harness", "mcp"],
};

/** Prompt-facing types: skill / framework / plugin prose+metadata. */
const PROMPT_TYPES = new Set(["skills", "frameworks", "plugins"]);

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

export function materializeCapabilityCapsule({
  runRoot, specialistId, packages, exclusions = [], spawnSyncFn,
}) {
  const records = [];
  try {
    for (const item of packages) {
      const manifest = normalizeCapabilityManifest(JSON.parse(fs.readFileSync(
        path.join(item.packageDir, "capability.json"), "utf8"
      )), { packageDir: item.packageDir });
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
      const promptBytes = materializedPromptBytes(runRoot, resolved);
      const promptEst = estimatePromptTokenContribution(promptBytes);
      const schema = materializedMcpSchemaBytes(runRoot, resolved, { spawnSyncFn });
      records.push({
        package: item.package, id: item.id, version: item.version,
        checksum: item.checksum, reason: item.reason, resolved,
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

export function buildStrictMcpConfig(effective, runRoot) {
  const mcpServers = {};
  for (const item of effective.packages) {
    for (const rel of item.resolved.mcps) {
      const document = JSON.parse(fs.readFileSync(path.join(runRoot, rel), "utf8"));
      for (const [name, server] of Object.entries(document.mcpServers ?? {})) {
        if (mcpServers[name]) {
          throw new Error(`MCP_NAME_COLLISION: ${name}`);
        }
        mcpServers[name] = server;
      }
    }
  }
  return { mcpServers };
}

export { mcpSchemaBytesFromToolsList } from "./mcp-schema.mjs";
