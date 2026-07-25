import fs from "node:fs";
import path from "node:path";
import { teamUpHome } from "../paths.mjs";
import { atomicWriteJson } from "../json-store.mjs";
import {
  validateManifest,
  loadManifestFromDir,
  sha256Declared,
  declaredPackageFiles,
  inspectPackageDir,
} from "./manifest.mjs";
import { assertSafeSpecialistSegment, assertPathInsideRoot } from "./safe-id.mjs";

const PACKAGE_FILES = [
  "specialist.json",
  "instructions.md",
  "package.json",
];

function specialistsRoot(env = process.env) {
  return path.join(teamUpHome(env), "specialists");
}

function indexPath(env = process.env) {
  return path.join(teamUpHome(env), "specialists-index.json");
}

function pinsPath(env = process.env) {
  return path.join(teamUpHome(env), "specialists-pins.json");
}

function loadIndex(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(indexPath(env), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { specialists: {}, versions: {} };
    throw e;
  }
}

function saveIndex(index, env = process.env) {
  atomicWriteJson(indexPath(env), index);
}

function loadPins(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(pinsPath(env), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { pins: {} };
    throw e;
  }
}

function savePins(pins, env = process.env) {
  atomicWriteJson(pinsPath(env), pins);
}

function copyDeclaredFiles(src, dest, files) {
  const srcRoot = path.resolve(src);
  const destRoot = path.resolve(dest);
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of files) {
    const from = path.join(srcRoot, rel);
    const to = path.join(destRoot, rel);
    assertPathInsideRoot(from, srcRoot);
    assertPathInsideRoot(to, destRoot);
    if (!fs.existsSync(from)) continue;
    if (fs.lstatSync(from).isSymbolicLink()) {
      throw new Error(`refusing to copy symlink: ${from}`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

export async function inspectPackage(packageDir) {
  try {
    const abs = path.resolve(packageDir);
    const inspected = inspectPackageDir(abs);
    const { manifest } = loadManifestFromDir(abs);
    const validation = validateManifest(manifest, { packageDir: abs });
    const checksum = sha256Declared(abs, inspected.files);
    return {
      ok: validation.ok && inspected.ok,
      errors: [...(inspected.errors || []), ...validation.errors],
      manifest,
      checksum,
      path: abs,
    };
  } catch (e) {
    return { ok: false, errors: [String(e.message || e)] };
  }
}

export async function installPackage(packageDir, env = process.env) {
  const abs = path.resolve(packageDir);
  let manifest;
  try {
    ({ manifest } = loadManifestFromDir(abs));
  } catch (e) {
    return { ok: false, errors: [String(e.message || e)] };
  }
  const validation = validateManifest(manifest, { packageDir: abs });
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  try {
    assertSafeSpecialistSegment(manifest.id, "id");
    assertSafeSpecialistSegment(manifest.version, "version");
  } catch (e) {
    return { ok: false, errors: [e.message] };
  }

  const inspected = inspectPackageDir(abs);
  if (!inspected.ok) {
    return { ok: false, errors: inspected.errors };
  }
  const checksum = sha256Declared(abs, inspected.files);
  const root = specialistsRoot(env);
  const dest = path.join(
    root,
    manifest.id,
    manifest.version,
    checksum.replace(/^sha256:/, "")
  );
  try {
    assertPathInsideRoot(dest, root);
  } catch (e) {
    return { ok: false, errors: [e.message] };
  }

  if (!fs.existsSync(dest)) {
    const staging = `${dest}.staging-${process.pid}-${Date.now().toString(36)}`;
    try {
      assertPathInsideRoot(staging, root);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      copyDeclaredFiles(abs, staging, inspected.files);
      fs.renameSync(staging, dest);
    } catch (e) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: false, errors: [String(e.message || e)] };
    }
  }

  const index = loadIndex(env);
  if (!index.versions) index.versions = {};
  if (!index.versions[manifest.id]) index.versions[manifest.id] = [];
  const versionEntry = {
    id: manifest.id,
    version: manifest.version,
    checksum,
    path: dest,
    installed_at: new Date().toISOString(),
  };
  const versions = index.versions[manifest.id];
  const existingIdx = versions.findIndex((v) => v.checksum === checksum);
  if (existingIdx === -1) versions.push(versionEntry);
  else versions[existingIdx] = versionEntry;

  // First install selects; later installs never silently replace selection/pin.
  if (!index.specialists?.[manifest.id]) {
    index.specialists[manifest.id] = versionEntry;
  }

  saveIndex(index, env);
  return { ok: true, id: manifest.id, version: manifest.version, checksum, path: dest };
}

export function pinSpecialist(id, { version, checksum, project, env = process.env } = {}) {
  assertSafeSpecialistSegment(id, "id");
  if (version) assertSafeSpecialistSegment(version, "version");
  const index = loadIndex(env);
  const versions = index.versions?.[id] || [];
  let entry = versions.find((v) =>
    (!version || v.version === version) && (!checksum || v.checksum === checksum)
  );
  if (!entry && index.specialists?.[id]) {
    entry = index.specialists[id];
    if (version && entry.version !== version) entry = null;
    if (checksum && entry?.checksum !== checksum) entry = null;
  }
  if (!entry) return { ok: false, errors: [`no installed version for ${id}`] };
  const pins = loadPins(env);
  if (!pins.pins) pins.pins = {};
  const key = project ? `${id}::${path.resolve(project)}` : id;
  pins.pins[key] = {
    id,
    version: entry.version,
    checksum: entry.checksum,
    path: entry.path,
    project: project ? path.resolve(project) : null,
    pinned_at: new Date().toISOString(),
  };
  // Global pin also updates selected
  if (!project) {
    pins.pins[id] = pins.pins[key];
    index.specialists[id] = entry;
    saveIndex(index, env);
  }
  savePins(pins, env);
  return { ok: true, pin: pins.pins[key] };
}

export function listInstalled(env = process.env) {
  return loadIndex(env);
}

export function resolveInstalled(id, { version, checksum, project, env = process.env } = {}) {
  assertSafeSpecialistSegment(id, "id");
  if (version) assertSafeSpecialistSegment(version, "version");
  const pins = loadPins(env);
  if (project) {
    const key = `${id}::${path.resolve(project)}`;
    const pin = pins.pins?.[key];
    if (pin) {
      if (version && pin.version !== version) return null;
      if (checksum && pin.checksum !== checksum) return null;
      return pin;
    }
  }
  const globalPin = pins.pins?.[id];
  if (globalPin && !version && !checksum) return globalPin;

  const index = loadIndex(env);
  if (version || checksum) {
    const hit = (index.versions?.[id] || []).find((v) =>
      (!version || v.version === version) && (!checksum || v.checksum === checksum)
    );
    if (hit) return hit;
  }
  const entry = index.specialists?.[id];
  if (!entry) return null;
  if (version && entry.version !== version) return null;
  if (checksum && entry.checksum !== checksum) return null;
  return entry;
}

export function loadInstalledManifest(id, opts = {}) {
  // Backward compatible: second arg may be env object (has TEAM_UP_* / PATH keys)
  const options =
    opts && typeof opts === "object" && (opts.project != null || opts.version != null || opts.checksum != null || opts.env != null)
      ? opts
      : { env: opts && typeof opts === "object" ? opts : process.env };
  const env = options.env || process.env;
  const entry = resolveInstalled(id, {
    version: options.version,
    checksum: options.checksum,
    project: options.project,
    env,
  });
  if (!entry) return null;
  const { manifest } = loadManifestFromDir(entry.path);
  return { ...entry, manifest };
}

/**
 * Recompute checksum of an installed package tree and compare to the indexed pin.
 * Throws Error with code PACKAGE_INTEGRITY_FAILED on mismatch.
 */
export function verifyInstalledIntegrity(entry, manifest) {
  if (!entry?.path || !entry?.checksum) {
    const err = new Error("PACKAGE_INTEGRITY_FAILED: missing installed entry");
    err.code = "PACKAGE_INTEGRITY_FAILED";
    throw err;
  }
  const files = declaredPackageFiles(entry.path, manifest || loadManifestFromDir(entry.path).manifest);
  const actual = sha256Declared(entry.path, files);
  if (actual !== entry.checksum) {
    const err = new Error(
      `PACKAGE_INTEGRITY_FAILED: expected ${entry.checksum}, got ${actual}`
    );
    err.code = "PACKAGE_INTEGRITY_FAILED";
    throw err;
  }
  return actual;
}

export { validateManifest, PACKAGE_FILES, declaredPackageFiles };
