import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, loadJson } from "../json-store.mjs";
import { capabilityPoolRoot } from "../paths.mjs";
import {
  declaredCapabilityFiles,
  normalizeCapabilityManifest,
} from "./manifest.mjs";

export function checksumFiles(root, files, manifest) {
  const hash = crypto.createHash("sha256");
  const normalizedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  hash.update("capability.json"); hash.update("\0");
  hash.update(String(Buffer.byteLength(normalizedManifest))); hash.update("\0");
  hash.update(normalizedManifest);
  for (const rel of [...files].sort()) {
    const bytes = fs.readFileSync(path.join(root, rel));
    hash.update(rel); hash.update("\0");
    hash.update(String(bytes.length)); hash.update("\0");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function capabilityMetrics(root, manifest) {
  const skillBytes = manifest.provides.skills.reduce((sum, rel) =>
    sum + fs.statSync(path.join(root, rel)).size, 0);
  const mcpToolCount = manifest.provides.mcps.reduce((sum, rel) => {
    const doc = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
    return sum + (Array.isArray(doc.tools) ? doc.tools.length : 0);
  }, 0);
  return {
    estimated_description_tokens: Math.ceil(skillBytes / 4),
    mcp_tool_count: mcpToolCount,
    plugin_metadata: manifest.provides.plugins,
    framework_metadata: manifest.provides.frameworks,
    permissions: manifest.permissions,
    warnings: manifest.warnings ?? [],
  };
}

export function inspectCapabilitySource(source, { manifestOverride } = {}) {
  const root = fs.realpathSync(source);
  const input = manifestOverride ?? JSON.parse(fs.readFileSync(
    path.join(root, "capability.json"), "utf8"
  ));
  const manifest = normalizeCapabilityManifest(input, { packageDir: root });
  const files = declaredCapabilityFiles(root, manifest);
  return {
    root, manifest, files,
    checksum: checksumFiles(root, files, manifest),
    ...capabilityMetrics(root, manifest),
  };
}

export function importLocalCapability(source, {
  env = process.env,
  sourceMetadata = { type: "local", path: path.resolve(source) },
  manifestOverride,
} = {}) {
  const preview = inspectCapabilitySource(source, { manifestOverride });
  const { root, manifest, files, checksum } = preview;
  const digest = checksum.slice("sha256:".length);
  const pool = capabilityPoolRoot(env);
  const destination = path.join(pool, manifest.id, manifest.version, digest);
  const indexPath = path.join(pool, "index.json");
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(destination), ".import-"));
    try {
      const packageDir = path.join(staging, "package");
      fs.mkdirSync(packageDir, { recursive: true });
      for (const rel of files) {
        fs.mkdirSync(path.dirname(path.join(packageDir, rel)), { recursive: true });
        fs.copyFileSync(path.join(root, rel), path.join(packageDir, rel));
      }
      fs.writeFileSync(path.join(packageDir, "capability.json"),
        `${JSON.stringify(manifest, null, 2)}\n`);
      atomicWriteJson(path.join(staging, "source.json"), sourceMetadata);
      fs.renameSync(staging, destination);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  const record = {
    package: `${manifest.id}@${manifest.version}`,
    id: manifest.id,
    version: manifest.version,
    checksum,
    packageDir: path.join(destination, "package"),
    source: sourceMetadata,
    imported_at: new Date().toISOString(),
    estimated_description_tokens: preview.estimated_description_tokens,
    mcp_tool_count: preview.mcp_tool_count,
    plugin_metadata: preview.plugin_metadata,
    framework_metadata: preview.framework_metadata,
    permissions: preview.permissions,
    warnings: preview.warnings,
  };
  const index = loadJson(indexPath) ?? { schema_version: 1, packages: [] };
  if (!index.packages.some((item) => item.checksum === checksum &&
      item.package === record.package)) {
    index.packages.push(record);
    index.packages.sort((a, b) =>
      `${a.package}:${a.checksum}`.localeCompare(`${b.package}:${b.checksum}`));
    atomicWriteJson(indexPath, index);
  }
  return record;
}

export function listInstalledCapabilities({ env = process.env } = {}) {
  return loadJson(path.join(capabilityPoolRoot(env), "index.json"))?.packages ?? [];
}

export function inspectInstalledCapability(selector, {
  checksum, env = process.env,
} = {}) {
  const matches = listInstalledCapabilities({ env }).filter((item) =>
    item.package === selector && (!checksum || item.checksum === checksum));
  if (matches.length !== 1) {
    throw new Error(`capability selector must resolve exactly once: ${selector}`);
  }
  return matches[0];
}
