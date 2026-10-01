import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { capabilityPoolRoot } from "../paths.mjs";
import { normalizeCapabilityManifest } from "./manifest.mjs";
import { HOST_TARGET, providedSkillDirs } from "./skill-scope.mjs";

/**
 * Host skill directories that `--for host` links into.
 *
 * `TEAM_UP_HOST_SKILL_ROOTS` takes a PATH-style list, for a host that runs
 * more than one CLI (`~/.claude/skills:~/.codex/skills`).
 */
export function hostSkillRoots(env = process.env) {
  const raw = env.TEAM_UP_HOST_SKILL_ROOTS;
  if (raw) return raw.split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
  return [path.join(env.HOME || os.homedir(), ".claude", "skills")];
}

function insidePool(target, env) {
  const pool = path.resolve(capabilityPoolRoot(env));
  const rel = path.relative(pool, path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * A link is team-up's to manage only if it points into the pool. Everything
 * else in the host skill directory — a hand-written skill, a plugin's link,
 * a dangling link somebody else left — belongs to the human.
 */
function readManagedLink(abs, env) {
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (!stat.isSymbolicLink()) return null;
  const target = path.resolve(path.dirname(abs), fs.readlinkSync(abs));
  return insidePool(target, env) ? target : null;
}

/**
 * Link name → pool directory for every assignment that targets the host.
 *
 * Only skills: a plugin, MCP server or framework needs host registration a
 * symlink cannot do, and linking just the skills of such a package would
 * share half of it without saying so.
 */
export function desiredHostLinks({ assignments, installed, missing = [] }) {
  const byKey = new Map(installed.map((item) => [`${item.package}:${item.checksum}`, item]));
  const links = new Map();
  for (const row of assignments) {
    if (!row.targets.includes(HOST_TARGET)) continue;
    const item = byKey.get(`${row.package}:${row.checksum}`);
    // A row whose package left the pool gets no link (and loses a stale one)
    // rather than blocking every other host change; `doctor` reports the row.
    if (!item) {
      missing.push({ package: row.package, checksum: row.checksum });
      continue;
    }
    const manifest = normalizeCapabilityManifest(JSON.parse(fs.readFileSync(
      path.join(item.packageDir, "capability.json"), "utf8"
    )), { packageDir: item.packageDir });
    const { plugins, mcps, frameworks } = manifest.provides;
    if (plugins.length || mcps.length || frameworks.length) {
      throw new Error(`HOST_LINK_UNSUPPORTED: ${row.package} provides more than skills; only skills can be shared with the host by link`);
    }
    for (const { name, dir } of providedSkillDirs(manifest)) {
      const target = path.join(item.packageDir, dir);
      const prior = links.get(name);
      if (prior && prior.target !== target) {
        throw new Error(`HOST_LINK_COLLISION: skill "${name}" from ${prior.package} and ${row.package}`);
      }
      links.set(name, { name, target, package: row.package, checksum: row.checksum });
    }
  }
  return links;
}

/**
 * What the host skill directories hold now versus what the assignments say.
 *
 * Planned in full before anything moves, so a caller can refuse on a
 * collision in any root before a single link has changed. A blocked link is
 * listed in `conflicts`, never in `create`.
 */
export function planHostLinks({ assignments, installed, env = process.env, roots = hostSkillRoots(env) }) {
  const missing = [];
  const desired = desiredHostLinks({ assignments, installed, missing });
  const create = [];
  const remove = [];
  const conflicts = [];
  for (const root of roots) {
    const present = fs.existsSync(root) ? fs.readdirSync(root) : [];
    for (const name of present) {
      const abs = path.join(root, name);
      const managed = readManagedLink(abs, env);
      if (managed === null) continue;
      const want = desired.get(name);
      if (!want || path.resolve(want.target) !== managed) remove.push({ path: abs });
    }
    for (const want of desired.values()) {
      const abs = path.join(root, want.name);
      const managed = readManagedLink(abs, env);
      if (managed !== null) {
        if (managed !== path.resolve(want.target)) create.push({ path: abs, target: want.target });
        continue;
      }
      let occupied = false;
      try {
        fs.lstatSync(abs);
        occupied = true;
      } catch {
        occupied = false;
      }
      if (occupied) conflicts.push({ path: abs, package: want.package });
      else create.push({ path: abs, target: want.target });
    }
  }
  return { desired: [...desired.values()], create, remove, conflicts, missing };
}

function makeReadOnly(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) makeReadOnly(abs);
    else if (entry.isFile()) fs.chmodSync(abs, 0o444);
  }
}

/**
 * Bring the host skill directories in line with the assignments.
 *
 * Never throws on a collision: refusing is the caller's decision, made
 * before it records an assignment. Here a blocked link is skipped and
 * reported, and an entry that is not a team-up link is never touched.
 */
export function syncHostLinks({ assignments, installed, env = process.env, roots = hostSkillRoots(env) }) {
  const plan = planHostLinks({ assignments, installed, env, roots });
  for (const item of plan.remove) fs.rmSync(item.path, { force: true });
  for (const item of plan.create) {
    // Read-only, so an editor opened through the host link refuses to save
    // instead of changing what specialists run. Launch re-checks the checksum
    // either way; this only makes the mistake loud at the moment it happens.
    makeReadOnly(item.target);
    fs.mkdirSync(path.dirname(item.path), { recursive: true });
    fs.rmSync(item.path, { force: true });
    fs.symlinkSync(item.target, item.path, "dir");
  }
  return {
    linked: plan.create.map((item) => item.path),
    unlinked: plan.remove.map((item) => item.path),
    missing: plan.missing,
    conflicts: plan.conflicts,
  };
}

/** Every team-up link currently present in the host skill directories. */
export function listHostLinks({ env = process.env, roots = hostSkillRoots(env) } = {}) {
  const out = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).sort()) {
      const target = readManagedLink(path.join(root, name), env);
      if (target !== null) out.push({ path: path.join(root, name), target });
    }
  }
  return out;
}
