import fs from "node:fs";
import path from "node:path";

/**
 * The three skill layers.
 *
 * - `main`: the host session only. Memory, dispatch, intake — the things that
 *   decide what is remembered or what runs next. Never enters a capsule.
 * - `shared`: the host and every specialist. Kept small on purpose: each
 *   token here is paid once per specialist launch.
 * - `specialist`: specialists only. The reason a specialist exists is that
 *   the host does not carry this.
 *
 * Unscoped packages keep the old behaviour: any target the human picks.
 */
export const SKILL_SCOPES = Object.freeze(["main", "shared", "specialist"]);

/** Assignment target that means "the host session", not a specialist. */
export const HOST_TARGET = "host";

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text));
  return match ? match[1] : null;
}

/**
 * `team-up-scope` from a skill file's frontmatter, or null.
 *
 * Read at any nesting depth so it can sit under the Agent Skills `metadata:`
 * map, which is where hosts expect keys they do not know.
 */
export function skillScopeFromText(text, label = "skill") {
  const block = frontmatter(text);
  if (block === null) return null;
  const match = /^\s*team-up-scope:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(block);
  if (!match) return null;
  const scope = match[1];
  if (!SKILL_SCOPES.includes(scope)) {
    throw new Error(`invalid team-up-scope "${scope}" in ${label} (expected ${SKILL_SCOPES.join("|")})`);
  }
  return scope;
}

export function skillScopeFromFile(file) {
  return skillScopeFromText(fs.readFileSync(file, "utf8"), file);
}

function skillFilesIn(abs) {
  const stat = fs.lstatSync(abs);
  if (stat.isFile()) return abs.endsWith(".md") ? [abs] : [];
  if (!stat.isDirectory()) return [];
  const direct = path.join(abs, "SKILL.md");
  return fs.existsSync(direct) ? [direct] : [];
}

/**
 * Where each `provides.skills` entry lands, by the same rule the capsule uses
 * (`capsule.mjs` DESTINATIONS): under `skills/<name>/…` the skill is called
 * `<name>`; anything else is filed under the package id. `dir` is the
 * package-relative directory that holds it — what a host link points at.
 */
export function providedSkillDirs(manifest) {
  return (manifest.provides?.skills ?? []).map((rel) => {
    const parts = rel.split(/[\\/]/).filter(Boolean);
    if (parts[0] === "skills" && parts.length >= 2) {
      return { name: parts[1], dir: path.join("skills", parts[1]) };
    }
    return { name: manifest.id, dir: "" };
  });
}

export function providedSkillNames(manifest) {
  return providedSkillDirs(manifest).map((entry) => entry.name);
}

/**
 * One scope for the whole package, or null when nothing declares one.
 *
 * A package is assigned as a unit, so a `main` skill and a `specialist` skill
 * in one package cannot both be honoured. That is refused rather than
 * resolved: picking either silently puts a skill where its author said it
 * must not go.
 */
export function capabilityScope(manifest, packageDir) {
  const declared = manifest.scope ?? null;
  if (declared !== null && !SKILL_SCOPES.includes(declared)) {
    throw new Error(`invalid capability scope "${declared}" (expected ${SKILL_SCOPES.join("|")})`);
  }
  const found = new Set();
  if (packageDir) {
    for (const rel of manifest.provides?.skills ?? []) {
      for (const file of skillFilesIn(path.join(packageDir, rel))) {
        const scope = skillScopeFromFile(file);
        if (scope) found.add(scope);
      }
    }
  }
  if (declared !== null) found.add(declared);
  if (found.size > 1) {
    throw new Error(`CAPABILITY_SCOPE_CONFLICT: ${manifest.id} declares ${[...found].sort().join(" and ")}`);
  }
  return found.size ? [...found][0] : null;
}

/** Refuse an assignment that would put a package outside its layer. */
export function assertScopeAllowsTarget(scope, target, label = "capability") {
  if (scope === "main" && target !== HOST_TARGET) {
    throw new Error(`CAPABILITY_SCOPE_MAIN: ${label} is main-only; enable it --for ${HOST_TARGET}, never for a specialist or all`);
  }
  if (scope === "specialist" && target === HOST_TARGET) {
    throw new Error(`CAPABILITY_SCOPE_SPECIALIST: ${label} is specialist-only; the host session does not carry it`);
  }
}
