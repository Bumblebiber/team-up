import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";

export const CONTENT_MANIFEST_SCHEMA = "team-up.capsule-content/v1";

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

/**
 * Resolve and require that candidate stays strictly under runRoot
 * (or equals runRoot for the root itself).
 */
export function assertPathInsideRunRoot(candidate, runRoot, { label = "path" } = {}) {
  if (!runRoot) fail("CONTENT_MANIFEST_REQUIRED", "CONTENT_MANIFEST_REQUIRED: runRoot required");
  const root = path.resolve(runRoot);
  const resolved = path.resolve(candidate);
  const rootReal = (() => {
    try {
      return fs.realpathSync.native(root);
    } catch {
      return root;
    }
  })();
  // Candidate may not exist yet for missing-path errors; still check lexical containment.
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    fail(
      "CONTENT_MANIFEST_ROOT_ESCAPE",
      `CONTENT_MANIFEST_ROOT_ESCAPE: ${label} ${resolved} outside runRoot ${root}`
    );
  }
  // If it exists, also require realpath stays inside the real runRoot.
  try {
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink()) {
      fail(
        "CONTENT_MANIFEST_SYMLINK",
        `CONTENT_MANIFEST_SYMLINK: ${label} ${resolved} is a symlink`
      );
    }
    const real = fs.realpathSync.native(resolved);
    if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
      fail(
        "CONTENT_MANIFEST_ROOT_ESCAPE",
        `CONTENT_MANIFEST_ROOT_ESCAPE: ${label} realpath ${real} outside runRoot ${rootReal}`
      );
    }
    return real;
  } catch (e) {
    if (e.code?.startsWith("CONTENT_MANIFEST_")) throw e;
    return resolved;
  }
}

/**
 * Read file bytes without following symlinks (O_NOFOLLOW where supported).
 * Compares lstat/fstat identity to defeat TOCTOU swaps.
 */
export function readFileNoFollow(filePath) {
  const lstat = fs.lstatSync(filePath);
  if (lstat.isSymbolicLink()) {
    fail("CONTENT_MANIFEST_SYMLINK", `CONTENT_MANIFEST_SYMLINK: ${filePath}`);
  }
  if (!lstat.isFile()) {
    fail(
      "CONTENT_MANIFEST_NONREGULAR",
      `CONTENT_MANIFEST_NONREGULAR: ${filePath} is not a regular file`
    );
  }
  let fd;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
    fd = fs.openSync(filePath, flags);
  } catch (e) {
    if (e.code === "ELOOP") {
      fail("CONTENT_MANIFEST_SYMLINK", `CONTENT_MANIFEST_SYMLINK: ${filePath}`);
    }
    throw e;
  }
  try {
    const fstat = fs.fstatSync(fd);
    if (fstat.ino !== lstat.ino || fstat.dev !== lstat.dev) {
      fail(
        "CONTENT_MANIFEST_TOCTOU",
        `CONTENT_MANIFEST_TOCTOU: ${filePath} identity changed while opening`
      );
    }
    if (!fstat.isFile()) {
      fail(
        "CONTENT_MANIFEST_NONREGULAR",
        `CONTENT_MANIFEST_NONREGULAR: ${filePath} is not a regular file`
      );
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fileSha256(filePath) {
  return `sha256:${sha256Hex(readFileNoFollow(filePath))}`;
}

/**
 * List directory entries without following a symlink at `dirPath`.
 * Opens with O_DIRECTORY|O_NOFOLLOW when available, verifies lstat/fstat
 * identity, then reads via the held fd (`/proc/self/fd/N` on Linux) so a
 * concurrent directory↔symlink swap cannot race the readdir.
 *
 * Platform support boundary for team-up.context-isolation/v1 closed-world:
 * only Linux `/proc` fd-based readdir is accepted. Non-Linux hosts (and any
 * environment where `/proc/self/fd/N` is unavailable) fail closed with
 * CONTENT_MANIFEST_UNSUPPORTED_PLATFORM — never a weaker path-based listing.
 */
export function listDirectoryNoFollow(dirPath) {
  const lstat = fs.lstatSync(dirPath);
  if (lstat.isSymbolicLink()) {
    fail("CONTENT_MANIFEST_SYMLINK", `CONTENT_MANIFEST_SYMLINK: ${dirPath}`);
  }
  if (!lstat.isDirectory()) {
    fail(
      "CONTENT_MANIFEST_NONREGULAR",
      `CONTENT_MANIFEST_NONREGULAR: ${dirPath} is not a directory`
    );
  }
  const O_DIRECTORY = fsConstants.O_DIRECTORY || 0;
  const O_NOFOLLOW = fsConstants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(dirPath, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (e) {
    if (e.code === "ELOOP") {
      fail("CONTENT_MANIFEST_SYMLINK", `CONTENT_MANIFEST_SYMLINK: ${dirPath}`);
    }
    if (e.code === "ENOTDIR") {
      fail(
        "CONTENT_MANIFEST_NONREGULAR",
        `CONTENT_MANIFEST_NONREGULAR: ${dirPath} is not a directory`
      );
    }
    throw e;
  }
  try {
    const fstat = fs.fstatSync(fd);
    if (fstat.ino !== lstat.ino || fstat.dev !== lstat.dev) {
      fail(
        "CONTENT_MANIFEST_TOCTOU",
        `CONTENT_MANIFEST_TOCTOU: ${dirPath} identity changed while opening`
      );
    }
    if (!fstat.isDirectory()) {
      fail(
        "CONTENT_MANIFEST_NONREGULAR",
        `CONTENT_MANIFEST_NONREGULAR: ${dirPath} is not a directory`
      );
    }
    // Hold the directory fd across readdir so a path swap cannot redirect listing.
    // Content-isolation v1 requires fd-based listing; path readdir is TOCTOU-prone
    // and must not silently authorize closed-world manifests off Linux / without /proc.
    const viaFd = `/proc/self/fd/${fd}`;
    const forceNoProc = process.env.TEAM_UP_FORCE_NO_PROC_FD === "1";
    if (!forceNoProc && process.platform === "linux" && fs.existsSync(viaFd)) {
      return fs.readdirSync(viaFd);
    }
    fail(
      "CONTENT_MANIFEST_UNSUPPORTED_PLATFORM",
      "CONTENT_MANIFEST_UNSUPPORTED_PLATFORM: closed-world content-isolation/v1 requires Linux /proc fd readdir"
    );
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Closed-world walker: every filesystem node under root must be a directory
 * or regular file. Symlinks and special files are rejected. All paths must
 * remain inside runRoot. Directory listing uses listDirectoryNoFollow.
 */
export function walkClosedWorld(root, { runRoot } = {}) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  assertPathInsideRunRoot(root, runRoot, { label: "walk root" });
  const stack = [path.resolve(root)];
  while (stack.length) {
    const current = stack.pop();
    assertPathInsideRunRoot(current, runRoot, { label: "node" });
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (e) {
      fail("CONTENT_MANIFEST_PATH_MISSING", `CONTENT_MANIFEST_PATH_MISSING: ${current}`);
    }
    if (stat.isSymbolicLink()) {
      fail("CONTENT_MANIFEST_SYMLINK", `CONTENT_MANIFEST_SYMLINK: ${current}`);
    }
    if (stat.isDirectory()) {
      let entries;
      try {
        entries = listDirectoryNoFollow(current);
      } catch (e) {
        if (e.code?.startsWith("CONTENT_MANIFEST_")) throw e;
        fail("CONTENT_MANIFEST_PATH_MISSING", `CONTENT_MANIFEST_PATH_MISSING: ${current}`);
      }
      for (const entry of entries) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (stat.isFile()) {
      out.push(current);
      continue;
    }
    fail(
      "CONTENT_MANIFEST_NONREGULAR",
      `CONTENT_MANIFEST_NONREGULAR: ${current}`
    );
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

function looksLikeFilesystemPath(arg) {
  if (typeof arg !== "string" || !arg) return false;
  if (path.isAbsolute(arg)) return true;
  if (arg.startsWith(".") || arg.includes("/") || arg.includes("\\")) return true;
  return /\.(mjs|cjs|js|json|py|sh|bin|wasm)$/i.test(arg);
}

function collectMcpConfigPaths(mcpConfig, runRoot) {
  const paths = [];
  const mcpRoot = path.join(runRoot, "harness", "mcp");
  if (fs.existsSync(mcpRoot)) {
    for (const f of walkClosedWorld(mcpRoot, { runRoot })) paths.push(f);
  }
  for (const server of Object.values(mcpConfig?.mcpServers ?? {})) {
    if (server?.args) {
      for (const arg of server.args) {
        if (typeof arg !== "string" || !looksLikeFilesystemPath(arg)) continue;
        if (!path.isAbsolute(arg)) {
          fail(
            "CONTENT_MANIFEST_ROOT_ESCAPE",
            `CONTENT_MANIFEST_ROOT_ESCAPE: mcp arg ${arg} must be absolute capsule path`
          );
        }
        if (!fs.existsSync(arg)) {
          fail(
            "CONTENT_MANIFEST_PATH_MISSING",
            `CONTENT_MANIFEST_PATH_MISSING: mcp runtime ${arg}`
          );
        }
        assertPathInsideRunRoot(arg, runRoot, { label: "mcp runtime" });
        paths.push(arg);
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
    fail("CONTENT_MANIFEST_REQUIRED", "CONTENT_MANIFEST_REQUIRED: runRoot and effectivePath required");
  }
  const resolvedRunRoot = path.resolve(runRoot);
  assertPathInsideRunRoot(effectivePath, resolvedRunRoot, { label: "effectivePath" });
  if (!fs.existsSync(effectivePath)) {
    fail("CONTENT_MANIFEST_EFFECTIVE_MISSING", `CONTENT_MANIFEST_EFFECTIVE_MISSING: ${effectivePath}`);
  }

  const skillRoots = skillDirs.map((p) =>
    assertPathInsideRunRoot(p, resolvedRunRoot, { label: "skillDir" })
  );
  const pluginRoots = pluginDirs.map((p) =>
    assertPathInsideRunRoot(p, resolvedRunRoot, { label: "pluginDir" })
  );
  const frameworkRoots = frameworkDirs.map((p) =>
    assertPathInsideRunRoot(p, resolvedRunRoot, { label: "frameworkDir" })
  );
  const mcpPaths = collectMcpConfigPaths(mcpConfig, resolvedRunRoot);

  for (const dir of [...skillRoots, ...pluginRoots, ...frameworkRoots]) {
    if (!fs.existsSync(dir)) {
      fail("CONTENT_MANIFEST_PATH_MISSING", `CONTENT_MANIFEST_PATH_MISSING: ${dir}`);
    }
  }

  const candidates = new Set();
  for (const root of [...skillRoots, ...pluginRoots, ...frameworkRoots]) {
    for (const f of walkClosedWorld(root, { runRoot: resolvedRunRoot })) {
      candidates.add(path.resolve(f));
    }
  }
  // Parent plugins root: bind every file under harness/plugins so sibling
  // rogue plugins are part of the closed world (not only selected pluginDirs).
  const pluginsParent = path.join(resolvedRunRoot, "harness", "plugins");
  if (fs.existsSync(pluginsParent)) {
    for (const f of walkClosedWorld(pluginsParent, { runRoot: resolvedRunRoot })) {
      candidates.add(path.resolve(f));
    }
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
 * selected roots including MCP (closed-world). Never creates paths.
 */
export function verifyCapsuleContentManifest(manifest, {
  runRoot,
  skillDirs = [],
  pluginDirs = [],
  frameworkDirs = [],
} = {}) {
  if (!manifest || manifest.schema !== CONTENT_MANIFEST_SCHEMA) {
    fail("CONTENT_MANIFEST_SCHEMA", "CONTENT_MANIFEST_SCHEMA: invalid content manifest");
  }
  if (!Array.isArray(manifest.files) || !manifest.root_checksum) {
    fail("CONTENT_MANIFEST_CORRUPT", "CONTENT_MANIFEST_CORRUPT: missing files or root_checksum");
  }
  if (!runRoot) {
    fail("CONTENT_MANIFEST_REQUIRED", "CONTENT_MANIFEST_REQUIRED: runRoot required for closed-world verify");
  }
  const resolvedRunRoot = path.resolve(runRoot);

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
    fail("CONTENT_MANIFEST_ROOT_CHECKSUM", "CONTENT_MANIFEST_ROOT_CHECKSUM: root checksum mismatch");
  }

  const bound = new Set(files.map((f) => f.path));
  for (const entry of files) {
    assertPathInsideRunRoot(entry.path, resolvedRunRoot, { label: "manifest entry" });
    if (!fs.existsSync(entry.path)) {
      fail("CONTENT_MANIFEST_PATH_MISSING", `CONTENT_MANIFEST_PATH_MISSING: ${entry.path}`);
    }
    const actual = fileSha256(entry.path);
    if (actual !== entry.sha256) {
      fail("CONTENT_MANIFEST_CHECKSUM", `CONTENT_MANIFEST_CHECKSUM: ${entry.path}`);
    }
  }

  const roots = [
    ...skillDirs.map((p) => assertPathInsideRunRoot(p, resolvedRunRoot, { label: "skillDir" })),
    ...pluginDirs.map((p) => assertPathInsideRunRoot(p, resolvedRunRoot, { label: "pluginDir" })),
    ...frameworkDirs.map((p) =>
      assertPathInsideRunRoot(p, resolvedRunRoot, { label: "frameworkDir" })
    ),
  ];
  const mcpRoot = path.join(resolvedRunRoot, "harness", "mcp");
  if (fs.existsSync(mcpRoot)) roots.push(mcpRoot);
  const pluginsRoot = path.join(resolvedRunRoot, "harness", "plugins");
  if (fs.existsSync(pluginsRoot)) roots.push(pluginsRoot);

  for (const root of roots) {
    if (!fs.existsSync(root)) {
      fail("CONTENT_MANIFEST_PATH_MISSING", `CONTENT_MANIFEST_PATH_MISSING: ${root}`);
    }
    for (const found of walkClosedWorld(root, { runRoot: resolvedRunRoot })) {
      const abs = path.resolve(found);
      if (!bound.has(abs)) {
        fail("CONTENT_MANIFEST_UNEXPECTED_FILE", `CONTENT_MANIFEST_UNEXPECTED_FILE: ${abs}`);
      }
    }
  }
  return true;
}
