import fs from "node:fs";
import path from "node:path";
import { teamUpHome } from "../paths.mjs";
import { atomicWriteJson } from "../json-store.mjs";
import {
  validateManifest,
  loadManifestFromDir,
  sha256Dir,
} from "./manifest.mjs";

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

function loadIndex(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(indexPath(env), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { specialists: {} };
    throw e;
  }
}

function saveIndex(index, env = process.env) {
  atomicWriteJson(indexPath(env), index);
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isSymbolicLink()) {
      throw new Error(`refusing to copy symlink: ${from}`);
    }
    if (ent.isDirectory()) copyTree(from, to);
    else if (ent.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

export async function inspectPackage(packageDir) {
  try {
    const { manifest } = loadManifestFromDir(packageDir);
    const validation = validateManifest(manifest);
    const checksum = sha256Dir(packageDir);
    return {
      ok: validation.ok,
      errors: validation.errors,
      manifest,
      checksum,
      path: path.resolve(packageDir),
    };
  } catch (e) {
    return { ok: false, errors: [String(e.message || e)] };
  }
}

export async function installPackage(packageDir, env = process.env) {
  const abs = path.resolve(packageDir);
  const { manifest } = loadManifestFromDir(abs);
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  const checksum = sha256Dir(abs);
  const dest = path.join(
    specialistsRoot(env),
    manifest.id,
    manifest.version,
    checksum.replace(/^sha256:/, "")
  );
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyTree(abs, dest);
  }
  const index = loadIndex(env);
  index.specialists[manifest.id] = {
    id: manifest.id,
    version: manifest.version,
    checksum,
    path: dest,
    installed_at: new Date().toISOString(),
  };
  saveIndex(index, env);
  return { ok: true, id: manifest.id, version: manifest.version, checksum, path: dest };
}

export function listInstalled(env = process.env) {
  return loadIndex(env);
}

export function resolveInstalled(id, { version, env = process.env } = {}) {
  const index = loadIndex(env);
  const entry = index.specialists?.[id];
  if (!entry) return null;
  if (version && entry.version !== version) return null;
  return entry;
}

export function loadInstalledManifest(id, env = process.env) {
  const entry = resolveInstalled(id, { env });
  if (!entry) return null;
  const { manifest } = loadManifestFromDir(entry.path);
  return { ...entry, manifest };
}

export { validateManifest, PACKAGE_FILES };
