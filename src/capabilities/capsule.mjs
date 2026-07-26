import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../json-store.mjs";
import { normalizeCapabilityManifest } from "./manifest.mjs";

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

function materializedMcpSchemaBytes(runRoot, resolved) {
  let bytes = 0;
  for (const rel of resolved.mcps ?? []) {
    const full = path.join(runRoot, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    bytes += fs.statSync(full).size;
  }
  return bytes;
}

export function materializeCapabilityCapsule({
  runRoot, specialistId, packages, exclusions = [],
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
      const mcpSchemaBytes = materializedMcpSchemaBytes(runRoot, resolved);
      records.push({
        package: item.package, id: item.id, version: item.version,
        checksum: item.checksum, reason: item.reason, resolved,
        estimated_description_tokens: item.estimated_description_tokens ?? 0,
        mcp_tool_count: item.mcp_tool_count ?? 0,
        prompt_token_contribution: Math.ceil(promptBytes / 4),
        mcp_schema_bytes: mcpSchemaBytes,
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
      prompt_token_contribution: records.reduce(
        (sum, item) => sum + item.prompt_token_contribution, 0),
      mcp_schema_bytes: records.reduce(
        (sum, item) => sum + item.mcp_schema_bytes, 0),
    },
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
