import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  "install",
  "postinstall",
  "preinstall",
  "scripts",
]);

const VALID_TIERS = new Set(["frontier", "high", "medium", "low"]);
const VALID_REASONING = new Set(["max", "high", "medium", "low"]);

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

export function validateManifest(manifest) {
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

  // Concrete model name smell in string values under common forbidden fields already covered;
  // also reject top-level model-ish fields already handled.

  const profile = manifest.model_profile;
  if (profile && typeof profile === "object") {
    if (!VALID_TIERS.has(profile.tier)) {
      errors.push(`model_profile.tier must be frontier|high|medium|low (got ${profile.tier})`);
    }
    if (!VALID_REASONING.has(profile.reasoning)) {
      errors.push(`model_profile.reasoning must be max|high|medium|low (got ${profile.reasoning})`);
    }
  }

  if (manifest.output_contract && manifest.output_contract !== "team-up.result/v1") {
    errors.push(`unsupported output_contract: ${manifest.output_contract}`);
  }

  if (manifest.schema_version !== 1 && manifest.schema_version !== "1") {
    errors.push(`unsupported schema_version: ${manifest.schema_version}`);
  }

  return { ok: errors.length === 0, errors };
}

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest("hex")}`;
}

export function sha256Dir(root) {
  const hash = crypto.createHash("sha256");
  const files = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) files.push(p);
    }
  }
  walk(root);
  files.sort();
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(f));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function loadManifestFromDir(packageDir) {
  const manifestPath = path.join(packageDir, "specialist.json");
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return { manifest: raw, manifestPath };
}
