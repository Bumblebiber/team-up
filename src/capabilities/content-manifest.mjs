import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const CONTENT_MANIFEST_SCHEMA = "team-up.capsule-content/v1";

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function fileSha256(filePath) {
  return `sha256:${sha256Hex(fs.readFileSync(filePath))}`;
}

function walkFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (stat.isFile()) out.push(current);
  }
  return out;
}

function roleForPath(absPath, { skillDirs, pluginDirs, frameworkDirs, mcpPaths, effectivePath }) {
  const resolved = path.resolve(absPath);
  if (effectivePath && resolved === path.resolve(effectivePath)) return "effective";
  for (const p of mcpPaths) {
    if (resolved === path.resolve(p)) return "mcp";
  }
  for (const root of skillDirs) {
    if (resolved === path.resolve(root) || resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
      return "skill";
    }
  }
  for (const root of pluginDirs) {
    if (resolved === path.resolve(root) || resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
      return "plugin";
    }
  }
  for (const root of frameworkDirs) {
    if (resolved === path.resolve(root) || resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
      return "framework";
    }
  }
  return "file";
}

function collectMcpConfigPaths(mcpConfig, runRoot) {
  const paths = [];
  // Materialized MCP JSON files under harness/mcp when present.
  const mcpRoot = path.join(runRoot, "harness", "mcp");
  if (fs.existsSync(mcpRoot)) {
    for (const f of walkFiles(mcpRoot)) paths.push(f);
  }
  // Also bind any absolute config path referenced by the capsule if it exists.
  for (const server of Object.values(mcpConfig?.mcpServers ?? {})) {
    if (server?.args) {
      for (const arg of server.args) {
        if (typeof arg === "string" && arg.endsWith(".json") && path.isAbsolute(arg) && fs.existsSync(arg)) {
          paths.push(arg);
        }
      }
    }
  }
  return [...new Set(paths.map((p) => path.resolve(p)))];
}

/**
 * Build a schema-versioned content manifest binding every selected materialized
 * file plus the effective capabilities record. Root checksum covers the
 * canonical file list (path + role + hash), not directory mtimes.
 */
export function buildCapsuleContentManifest({
  runRoot,
  skillDirs = [],
  pluginDirs = [],
  frameworkDirs = [],
  mcpConfig = { mcpServers: {} },
  effectivePath,
}) {
  if (!runRoot || !effectivePath) {
    const err = new Error("CONTENT_MANIFEST_REQUIRED: runRoot and effectivePath required");
    err.code = "CONTENT_MANIFEST_REQUIRED";
    throw err;
  }
  if (!fs.existsSync(effectivePath)) {
    const err = new Error(`CONTENT_MANIFEST_EFFECTIVE_MISSING: ${effectivePath}`);
    err.code = "CONTENT_MANIFEST_EFFECTIVE_MISSING";
    throw err;
  }

  const skillRoots = skillDirs.map((p) => path.resolve(p));
  const pluginRoots = pluginDirs.map((p) => path.resolve(p));
  const frameworkRoots = frameworkDirs.map((p) => path.resolve(p));
  const mcpPaths = collectMcpConfigPaths(mcpConfig, path.resolve(runRoot));

  // Selected roots must already exist — never create them here.
  for (const dir of [...skillRoots, ...pluginRoots, ...frameworkRoots]) {
    if (!fs.existsSync(dir)) {
      const err = new Error(`CONTENT_MANIFEST_PATH_MISSING: ${dir}`);
      err.code = "CONTENT_MANIFEST_PATH_MISSING";
      throw err;
    }
  }

  const candidates = new Set();
  for (const root of [...skillRoots, ...pluginRoots, ...frameworkRoots]) {
    for (const f of walkFiles(root)) candidates.add(path.resolve(f));
  }
  for (const f of mcpPaths) candidates.add(f);
  candidates.add(path.resolve(effectivePath));

  const files = [...candidates]
    .sort()
    .map((abs) => ({
      path: abs,
      role: roleForPath(abs, {
        skillDirs: skillRoots,
        pluginDirs: pluginRoots,
        frameworkDirs: frameworkRoots,
        mcpPaths,
        effectivePath,
      }),
      sha256: fileSha256(abs),
    }));

  const canonical = JSON.stringify(
    files.map((f) => ({ path: f.path, role: f.role, sha256: f.sha256 }))
  );
  const rootChecksum = `sha256:${sha256Hex(canonical)}`;

  return {
    schema: CONTENT_MANIFEST_SCHEMA,
    files,
    root_checksum: rootChecksum,
  };
}

/**
 * Verify on-disk content against an authoritative content manifest.
 * Fail closed on any missing/changed file OR any unlisted file under
 * selected roots (closed-world). Never creates paths.
 */
export function verifyCapsuleContentManifest(manifest, {
  skillDirs = [],
  pluginDirs = [],
  frameworkDirs = [],
} = {}) {
  if (!manifest || manifest.schema !== CONTENT_MANIFEST_SCHEMA) {
    const err = new Error("CONTENT_MANIFEST_SCHEMA: invalid content manifest");
    err.code = "CONTENT_MANIFEST_SCHEMA";
    throw err;
  }
  if (!Array.isArray(manifest.files) || !manifest.root_checksum) {
    const err = new Error("CONTENT_MANIFEST_CORRUPT: missing files or root_checksum");
    err.code = "CONTENT_MANIFEST_CORRUPT";
    throw err;
  }

  const files = [...manifest.files]
    .map((f) => ({
      path: path.resolve(f.path),
      role: f.role,
      sha256: f.sha256,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const canonical = JSON.stringify(
    files.map((f) => ({ path: f.path, role: f.role, sha256: f.sha256 }))
  );
  const expectedRoot = `sha256:${sha256Hex(canonical)}`;
  if (expectedRoot !== manifest.root_checksum) {
    const err = new Error("CONTENT_MANIFEST_ROOT_CHECKSUM: root checksum mismatch");
    err.code = "CONTENT_MANIFEST_ROOT_CHECKSUM";
    throw err;
  }

  const bound = new Set(files.map((f) => f.path));
  for (const entry of files) {
    if (!fs.existsSync(entry.path)) {
      const err = new Error(`CONTENT_MANIFEST_PATH_MISSING: ${entry.path}`);
      err.code = "CONTENT_MANIFEST_PATH_MISSING";
      throw err;
    }
    const actual = fileSha256(entry.path);
    if (actual !== entry.sha256) {
      const err = new Error(`CONTENT_MANIFEST_CHECKSUM: ${entry.path}`);
      err.code = "CONTENT_MANIFEST_CHECKSUM";
      throw err;
    }
  }

  // Closed-world: every file under selected roots must be listed.
  const roots = [
    ...skillDirs.map((p) => path.resolve(p)),
    ...pluginDirs.map((p) => path.resolve(p)),
    ...frameworkDirs.map((p) => path.resolve(p)),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      const err = new Error(`CONTENT_MANIFEST_PATH_MISSING: ${root}`);
      err.code = "CONTENT_MANIFEST_PATH_MISSING";
      throw err;
    }
    for (const found of walkFiles(root)) {
      const abs = path.resolve(found);
      if (!bound.has(abs)) {
        const err = new Error(`CONTENT_MANIFEST_UNEXPECTED_FILE: ${abs}`);
        err.code = "CONTENT_MANIFEST_UNEXPECTED_FILE";
        throw err;
      }
    }
  }
  return true;
}
