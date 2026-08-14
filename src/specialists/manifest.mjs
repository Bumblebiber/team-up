import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertSafeSpecialistSegment, assertSafeRelPath, assertPathInsideRoot } from "./safe-id.mjs";
import { normalizeBudget } from "./budget.mjs";
import { normalizeRecommendations } from "../capabilities/recommendations.mjs";

export const REQUIRED = [
  "schema_version",
  "id",
  "display_name",
  "version",
  "remit",
  "anti_remit",
  "call_types",
  "accepted_inputs",
  "output_contract",
  "capabilities",
  "permissions",
  "budget",
  "model_profile",
  "eval_suite",
];

const FORBIDDEN_KEYS = new Set([
  "model",
  "provider",
  "preferred_model",
  "model_id",
  "model_name",
  "install",
  "postinstall",
  "preinstall",
  "scripts",
]);

const VALID_TIERS = new Set(["frontier", "high", "medium", "low"]);
const VALID_REASONING = new Set(["max", "high", "medium", "low"]);
const VALID_CALL_TYPES = new Set(["consult", "delegate", "review"]);
const VALID_FS = new Set(["none", "project_readonly", "project", "home"]);
const VALID_WRITES = new Set([false, true, "delegated_only"]);

const ALLOWED_TOP_LEVEL = new Set([
  "specialist.json",
  "instructions.md",
  "package.json",
  "README.md",
  "skills",
  "evals",
  "templates",
  "docs",
]);

const FORBIDDEN_PKG_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "prestart",
  "start",
]);

function walkKeys(value, pathParts, onKey) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkKeys(v, [...pathParts, String(i)], onKey));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      onKey(k, [...pathParts, k], v);
      walkKeys(v, [...pathParts, k], onKey);
    }
  }
}

function isSafeRelPath(p) {
  try {
    assertSafeRelPath(p, "path");
    return true;
  } catch {
    return false;
  }
}

export function validateManifest(manifest, { packageDir } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: ["manifest must be an object"] };
  }

  for (const key of REQUIRED) {
    if (manifest[key] === undefined || manifest[key] === null) {
      errors.push(`missing required key: ${key}`);
    }
  }

  walkKeys(manifest, [], (k, parts) => {
    if (FORBIDDEN_KEYS.has(k)) {
      errors.push(`forbidden key "${k}" at ${parts.join(".")} (no concrete model/provider/install hooks)`);
    }
  });

  try {
    if (manifest.id != null) assertSafeSpecialistSegment(String(manifest.id), "id");
  } catch (e) {
    errors.push(e.message);
  }
  try {
    if (manifest.version != null) assertSafeSpecialistSegment(String(manifest.version), "version");
  } catch (e) {
    errors.push(e.message);
  }

  if (Array.isArray(manifest.call_types)) {
    for (const ct of manifest.call_types) {
      if (!VALID_CALL_TYPES.has(ct)) errors.push(`invalid call_type: ${ct}`);
    }
  } else if (manifest.call_types != null) {
    errors.push("call_types must be an array");
  }

  const profile = manifest.model_profile;
  if (profile && typeof profile === "object") {
    if (!VALID_TIERS.has(profile.tier)) {
      errors.push(`model_profile.tier must be frontier|high|medium|low (got ${profile.tier})`);
    }
    if (!VALID_REASONING.has(profile.reasoning)) {
      errors.push(`model_profile.reasoning must be max|high|medium|low (got ${profile.reasoning})`);
    }
  }

  const perms = manifest.permissions;
  if (perms && typeof perms === "object") {
    if (perms.filesystem != null && !VALID_FS.has(perms.filesystem)) {
      errors.push(`invalid permissions.filesystem: ${perms.filesystem}`);
    }
    if (perms.writes != null && !VALID_WRITES.has(perms.writes)) {
      errors.push(`invalid permissions.writes: ${perms.writes}`);
    }
    if (perms.network != null && typeof perms.network !== "boolean") {
      errors.push("permissions.network must be boolean");
    }
    if (perms.commands != null && !Array.isArray(perms.commands)) {
      errors.push("permissions.commands must be an array");
    }
  }

  const caps = manifest.capabilities;
  if (caps && typeof caps === "object") {
    for (const key of ["skills", "tools", "mcps", "frameworks"]) {
      if (caps[key] != null && !Array.isArray(caps[key])) {
        errors.push(`capabilities.${key} must be an array`);
      }
    }
    if (Array.isArray(caps.skills)) {
      for (const skill of caps.skills) {
        try {
          assertSafeSpecialistSegment(String(skill), "skill id");
        } catch (e) {
          errors.push(e.message);
        }
      }
    }
    for (const key of ["tools", "mcps", "frameworks"]) {
      if (!Array.isArray(caps[key])) continue;
      for (const item of caps[key]) {
        try {
          // Capability ids are single segments (may contain dots like filesystem.read)
          assertSafeSpecialistSegment(String(item), `capabilities.${key} entry`);
        } catch (e) {
          errors.push(e.message);
        }
      }
    }
  }

  const schemaVersion = Number(manifest.schema_version);
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    errors.push(`unsupported schema_version: ${manifest.schema_version}`);
  }

  // Recommendations are inert display metadata; they still have to be
  // well-formed so the operator skill can show them safely.
  if (manifest.recommendations != null) {
    try {
      normalizeRecommendations(manifest.recommendations);
    } catch (e) {
      errors.push(e.message);
    }
  }

  const budget = manifest.budget;
  if (budget && typeof budget === "object") {
    if (schemaVersion === 2 && budget.max_tokens != null) {
      errors.push("budget.max_tokens is not allowed in schema_version 2; use budget.tokens");
    }
    if (schemaVersion === 1 && budget.tokens != null) {
      errors.push("budget.tokens requires schema_version 2");
    }
    try {
      normalizeBudget(budget);
    } catch (e) {
      errors.push(e.message);
    }
  }

  if (manifest.eval_suite != null) {
    try {
      assertSafeRelPath(String(manifest.eval_suite), "eval_suite");
    } catch (e) {
      errors.push(e.message);
    }
  }

  if (manifest.output_contract && manifest.output_contract !== "team-up.result/v1") {
    errors.push(`unsupported output_contract: ${manifest.output_contract}`);
  }

  if (packageDir) {
    const pkgJsonPath = path.join(packageDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
        if (pkg.bin || pkg.directories?.bin) {
          errors.push("package.json must not declare executable bin entries");
        }
        if (pkg.scripts && typeof pkg.scripts === "object") {
          for (const name of Object.keys(pkg.scripts)) {
            if (FORBIDDEN_PKG_SCRIPTS.has(name) || /^(pre|post)/.test(name)) {
              errors.push(`package.json refuses lifecycle script: ${name}`);
            }
          }
        }
      } catch (e) {
        errors.push(`invalid package.json: ${e.message}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function declaredPackageFiles(packageDir, manifest) {
  const root = path.resolve(packageDir);
  const files = new Set(["specialist.json", "instructions.md"]);
  if (fs.existsSync(path.join(root, "package.json"))) files.add("package.json");
  if (fs.existsSync(path.join(root, "README.md"))) files.add("README.md");
  const skills = manifest?.capabilities?.skills || [];
  for (const skill of skills) {
    assertSafeSpecialistSegment(String(skill), "skill id");
    const rel = path.join("skills", `${skill}.md`);
    assertPathInsideRoot(path.join(root, rel), root);
    files.add(rel);
  }
  if (manifest?.eval_suite) {
    const rel = assertSafeRelPath(String(manifest.eval_suite), "eval_suite");
    assertPathInsideRoot(path.join(root, rel), root);
    files.add(rel);
  }
  return [...files].filter((rel) => {
    const abs = path.join(root, rel);
    try {
      assertPathInsideRoot(abs, root);
    } catch {
      return false;
    }
    return fs.existsSync(abs);
  });
}

export function inspectPackageDir(packageDir) {
  const errors = [];
  const abs = path.resolve(packageDir);
  let manifest;
  try {
    ({ manifest } = loadManifestFromDir(abs));
  } catch (e) {
    return { ok: false, errors: [String(e.message || e)], files: [] };
  }

  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) {
      errors.push(`refusing symlink at package root: ${ent.name}`);
      continue;
    }
    if (!ALLOWED_TOP_LEVEL.has(ent.name) && ent.name !== ".git") {
      // .git is ignored (not copied) but other undeclared top-level is rejected
      errors.push(`undeclared top-level entry: ${ent.name}`);
    }
    if (ent.name === ".git") {
      // allowed to exist in source repo but never hashed/copied
      continue;
    }
  }

  // Walk for symlinks inside allowed trees
  const files = declaredPackageFiles(abs, manifest);
  for (const rel of files) {
    const p = path.join(abs, rel);
    if (fs.lstatSync(p).isSymbolicLink()) {
      errors.push(`refusing symlink: ${rel}`);
    }
  }

  return { ok: errors.length === 0, errors, files, manifest };
}

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest("hex")}`;
}

/** Hash only declared package content — never .git or arbitrary repo files. */
export function sha256Declared(root, files) {
  const hash = crypto.createHash("sha256");
  const list = [...files].sort();
  for (const rel of list) {
    const f = path.join(root, rel);
    hash.update(rel.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(f));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** @deprecated prefer sha256Declared — kept for callers that still pass a dir of declared-only trees */
export function sha256Dir(root) {
  const { manifest } = loadManifestFromDir(root);
  return sha256Declared(root, declaredPackageFiles(root, manifest));
}

export function loadManifestFromDir(packageDir) {
  const manifestPath = path.join(packageDir, "specialist.json");
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return { manifest: raw, manifestPath };
}
