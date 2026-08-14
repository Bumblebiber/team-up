import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../json-store.mjs";
import { normalizeCapabilityManifest } from "./manifest.mjs";

/** Where each provide type lands inside a run capsule. */
const DESTINATIONS = {
  skills: ["context", "skills"],
  frameworks: ["context", "framework"],
  plugins: ["harness", "plugins"],
  mcps: ["harness", "mcp"],
};

function capsuleRelPath(type, id, rel) {
  const prefix = `${type}/`;
  // A package that already groups files under its type keeps that layout;
  // anything else is namespaced by capability id so two packages cannot
  // silently claim the same capsule path.
  return rel.startsWith(prefix) ? rel.slice(prefix.length) : path.join(id, rel);
}

/**
 * Copy exactly the effective packages' declared files into the run capsule and
 * write the audit record. Nothing about the pool index, unselected packages,
 * or the available-package catalog is materialized.
 */
export function materializeCapabilityCapsule({
  runRoot,
  specialistId,
  packages = [],
  exclusions = [],
}) {
  const records = [];
  try {
    for (const item of packages) {
      const manifest = normalizeCapabilityManifest(
        JSON.parse(
          fs.readFileSync(path.join(item.packageDir, "capability.json"), "utf8")
        ),
        { packageDir: item.packageDir }
      );
      const resolved = { skills: [], plugins: [], mcps: [], frameworks: [] };
      for (const [type, entries] of Object.entries(manifest.provides)) {
        for (const rel of entries) {
          const destination = path.join(
            runRoot,
            ...DESTINATIONS[type],
            capsuleRelPath(type, item.id, rel)
          );
          if (fs.existsSync(destination)) {
            throw new Error(
              `CAPSULE_PATH_COLLISION: ${path.relative(runRoot, destination)}`
            );
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
      records.push({
        package: item.package,
        id: item.id,
        version: item.version,
        checksum: item.checksum,
        reason: item.reason,
        resolved,
        estimated_description_tokens: item.estimated_description_tokens ?? 0,
        mcp_tool_count: item.mcp_tool_count ?? 0,
      });
    }
  } catch (error) {
    // A partially built capsule must never reach a worker.
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
        (sum, item) => sum + item.estimated_description_tokens,
        0
      ),
      mcp_tool_count: records.reduce((sum, item) => sum + item.mcp_tool_count, 0),
    },
  };
  atomicWriteJson(path.join(runRoot, "EFFECTIVE_CAPABILITIES.json"), record);
  return record;
}

/**
 * Strict MCP configuration built only from capsule descriptors. Duplicate
 * server names fail rather than letting one package shadow another's tools.
 */
export function buildStrictMcpConfig(effective, runRoot) {
  const mcpServers = {};
  for (const item of effective.packages) {
    for (const rel of item.resolved.mcps) {
      const document = JSON.parse(fs.readFileSync(path.join(runRoot, rel), "utf8"));
      for (const [name, server] of Object.entries(document.mcpServers ?? {})) {
        if (mcpServers[name]) throw new Error(`MCP_NAME_COLLISION: ${name}`);
        mcpServers[name] = server;
      }
    }
  }
  return { mcpServers };
}
