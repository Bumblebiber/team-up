import fs from "node:fs";
import path from "node:path";
import {
  assertPathInsideRoot,
  assertSafeRelPath,
  assertSafeSpecialistSegment,
} from "../specialists/safe-id.mjs";
import { SKILL_SCOPES, providedSkillNames } from "./skill-scope.mjs";

const PROVIDE_TYPES = ["skills", "plugins", "mcps", "frameworks"];
const FORBIDDEN = new Set([
  "model", "provider", "preferred_model", "model_id", "model_name",
  "install", "preinstall", "postinstall", "scripts",
]);

function walk(value, visit, parts = []) {
  if (Array.isArray(value)) return value.forEach((v, i) => walk(v, visit, [...parts, i]));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, [...parts, key]);
    walk(child, visit, [...parts, key]);
  }
}

export function normalizeCapabilityManifest(input, { packageDir } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("capability manifest must be an object");
  }
  walk(input, (key, parts) => {
    if (FORBIDDEN.has(key)) throw new Error(`forbidden key "${key}" at ${parts.join(".")}`);
  });
  if (input.schema_version !== 1) throw new Error("unsupported capability schema_version");
  assertSafeSpecialistSegment(String(input.id), "capability id");
  assertSafeSpecialistSegment(String(input.version), "capability version");
  if (!input.display_name || typeof input.display_name !== "string") {
    throw new Error("display_name must be a non-empty string");
  }
  const provides = {};
  for (const type of PROVIDE_TYPES) {
    const entries = input.provides?.[type] ?? [];
    if (!Array.isArray(entries)) throw new Error(`provides.${type} must be an array`);
    provides[type] = entries.map((entry) => assertSafeRelPath(String(entry), `${type} path`));
  }
  const permissions = {
    network: input.permissions?.network ?? false,
    commands: input.permissions?.commands ?? [],
    filesystem: input.permissions?.filesystem ?? "none",
  };
  if (typeof permissions.network !== "boolean" ||
      !Array.isArray(permissions.commands) ||
      !["none", "project_readonly", "project", "home"].includes(
        permissions.filesystem)) {
    throw new Error(
      "permissions require boolean network, commands array, and valid filesystem"
    );
  }
  if (input.scope !== undefined && !SKILL_SCOPES.includes(input.scope)) {
    throw new Error(`scope must be one of ${SKILL_SCOPES.join("|")}`);
  }
  const manifest = { ...input, provides, permissions };
  if (input.auto_invoke !== undefined) {
    manifest.auto_invoke = normalizeAutoInvoke(input.auto_invoke, manifest);
  }
  if (packageDir) declaredCapabilityFiles(packageDir, manifest);
  return manifest;
}

/**
 * Skills the launcher invokes at the top of every worker prompt.
 *
 * At most one: a harness takes one slash command per message, and a second
 * one would be pasted as plain text the model is free to read as data.
 */
function normalizeAutoInvoke(value, manifest) {
  if (!Array.isArray(value) || value.length > 1 ||
      value.some((name) => typeof name !== "string" || !name)) {
    throw new Error("auto_invoke must be an array of at most one skill name");
  }
  const provided = providedSkillNames(manifest);
  for (const name of value) {
    if (!provided.includes(name)) {
      throw new Error(`auto_invoke names a skill the package does not provide: ${name}`);
    }
  }
  return [...value];
}

export function declaredCapabilityFiles(packageDir, manifest) {
  const root = fs.realpathSync(packageDir);
  const files = [];
  const collect = (abs, rel) => {
    assertPathInsideRoot(abs, root);
    if (!fs.existsSync(abs)) throw new Error(`declared capability path missing: ${rel}`);
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink: ${rel}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        collect(path.join(abs, name), path.join(rel, name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`unsupported capability file type: ${rel}`);
    files.push(rel);
  };
  for (const type of PROVIDE_TYPES) {
    for (const rel of manifest.provides[type]) {
      const abs = path.join(root, rel);
      collect(abs, rel);
    }
  }
  return [...new Set(files)].sort();
}
