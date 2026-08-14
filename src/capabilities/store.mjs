import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, loadJson } from "../json-store.mjs";
import { capabilityPoolRoot } from "../paths.mjs";
import {
  declaredCapabilityFiles,
  declaredCapabilityFilesByType,
  normalizeCapabilityManifest,
} from "./manifest.mjs";

const CHECKSUM_PREFIX = "sha256:";

export function capabilityIndexPath(env = process.env) {
  return path.join(capabilityPoolRoot(env), "index.json");
}

/** Canonical on-disk manifest text — hashed and written byte-identically. */
export function manifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Content hash over the normalized manifest plus every declared file.
 * Name, byte length and bytes are NUL-separated so no rename or concatenation
 * can produce a colliding digest.
 */
export function checksumFiles(root, files, manifest) {
  const hash = crypto.createHash("sha256");
  const normalized = manifestText(manifest);
  hash.update("capability.json");
  hash.update("\0");
  hash.update(String(Buffer.byteLength(normalized)));
  hash.update("\0");
  hash.update(normalized);
  for (const rel of [...files].sort()) {
    const bytes = fs.readFileSync(path.join(root, rel));
    hash.update(rel);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return `${CHECKSUM_PREFIX}${hash.digest("hex")}`;
}

function capabilityMetrics(root, manifest) {
  const byType = declaredCapabilityFilesByType(root, manifest);
  const warnings = [...(manifest.warnings ?? [])];

  let skillBytes = 0;
  for (const declared of byType.skills) {
    for (const rel of declared.files) {
      skillBytes += fs.statSync(path.join(root, rel)).size;
    }
  }

  let mcpToolCount = 0;
  for (const declared of byType.mcps) {
    for (const rel of declared.files) {
      if (!rel.endsWith(".json")) continue;
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
      } catch {
        warnings.push(`unreadable mcp descriptor: ${rel}`);
        continue;
      }
      if (Array.isArray(doc?.tools)) mcpToolCount += doc.tools.length;
    }
  }

  return {
    // Rough prompt cost of the skill descriptions this package would add.
    estimated_description_tokens: Math.ceil(skillBytes / 4),
    mcp_tool_count: mcpToolCount,
    plugin_metadata: manifest.provides.plugins,
    framework_metadata: manifest.provides.frameworks,
    permissions: manifest.permissions,
    warnings,
  };
}

/** Read-only preview of a source directory. Never touches the pool. */
export function inspectCapabilitySource(source, { manifestOverride } = {}) {
  const root = fs.realpathSync(source);
  const input =
    manifestOverride ??
    JSON.parse(fs.readFileSync(path.join(root, "capability.json"), "utf8"));
  const manifest = normalizeCapabilityManifest(input, { packageDir: root });
  const files = declaredCapabilityFiles(root, manifest);
  return {
    root,
    manifest,
    files,
    checksum: checksumFiles(root, files, manifest),
    ...capabilityMetrics(root, manifest),
  };
}

function promoteStaging(staging, destination) {
  try {
    fs.renameSync(staging, destination);
  } catch (error) {
    // A concurrent import of identical content already published this
    // checksum; content-addressed storage makes that a no-op, not a conflict.
    if (
      (error.code === "EEXIST" || error.code === "ENOTEMPTY") &&
      fs.existsSync(destination)
    ) {
      fs.rmSync(staging, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

export function importLocalCapability(
  source,
  {
    env = process.env,
    sourceMetadata = { type: "local", path: path.resolve(source) },
    manifestOverride,
  } = {}
) {
  const preview = inspectCapabilitySource(source, { manifestOverride });
  const { root, manifest, files, checksum } = preview;
  const digest = checksum.slice(CHECKSUM_PREFIX.length);
  const pool = capabilityPoolRoot(env);
  const destination = path.join(pool, manifest.id, manifest.version, digest);

  if (!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(destination), ".import-"));
    try {
      const packageDir = path.join(staging, "package");
      fs.mkdirSync(packageDir, { recursive: true });
      for (const rel of files) {
        const target = path.join(packageDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(root, rel), target);
      }
      fs.writeFileSync(
        path.join(packageDir, "capability.json"),
        manifestText(manifest)
      );
      atomicWriteJson(path.join(staging, "capability.json"), {
        schema_version: 1,
        package: `${manifest.id}@${manifest.version}`,
        checksum,
      });
      atomicWriteJson(path.join(staging, "source.json"), sourceMetadata);
      promoteStaging(staging, destination);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  const record = {
    package: `${manifest.id}@${manifest.version}`,
    id: manifest.id,
    version: manifest.version,
    display_name: manifest.display_name,
    checksum,
    packageDir: path.join(destination, "package"),
    provides: manifest.provides,
    source: sourceMetadata,
    imported_at: new Date().toISOString(),
    estimated_description_tokens: preview.estimated_description_tokens,
    mcp_tool_count: preview.mcp_tool_count,
    plugin_metadata: preview.plugin_metadata,
    framework_metadata: preview.framework_metadata,
    permissions: preview.permissions,
    warnings: preview.warnings,
  };

  const indexPath = capabilityIndexPath(env);
  const index = loadJson(indexPath) ?? { schema_version: 1, packages: [] };
  const known = index.packages.some(
    (item) => item.checksum === checksum && item.package === record.package
  );
  if (!known) {
    index.packages.push(record);
    index.packages.sort((a, b) =>
      `${a.package}:${a.checksum}`.localeCompare(`${b.package}:${b.checksum}`)
    );
    atomicWriteJson(indexPath, index);
  }
  return record;
}

export function listInstalledCapabilities({ env = process.env } = {}) {
  return loadJson(capabilityIndexPath(env))?.packages ?? [];
}

/**
 * Exactly-one lookup. Two installed checksums for the same `id@version` are a
 * human decision, never an implicit newest-wins pick.
 */
export function inspectInstalledCapability(
  selector,
  { checksum, env = process.env } = {}
) {
  const matches = listInstalledCapabilities({ env }).filter(
    (item) => item.package === selector && (!checksum || item.checksum === checksum)
  );
  if (matches.length !== 1) {
    throw new Error(
      `capability selector must resolve exactly once: ${selector} (${matches.length} matches)`
    );
  }
  return matches[0];
}
