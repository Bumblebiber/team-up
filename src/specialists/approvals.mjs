import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { specialistApprovalsPath } from "../paths.mjs";
import { atomicWriteJson } from "../json-store.mjs";
import { resolveInstalled, loadInstalledManifest, verifyInstalledIntegrity } from "./store.mjs";
import { resolveCommandPolicyForApproval } from "../commands/policy.mjs";
import { mainCheckoutOf } from "./worktree.mjs";

function loadApprovals(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(specialistApprovalsPath(env), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { approvals: {} };
    throw e;
  }
}

function saveApprovals(data, env = process.env) {
  atomicWriteJson(specialistApprovalsPath(env), data);
}

/**
 * The directory a grant is about, as the filesystem sees it.
 *
 * `path.resolve` normalizes text; it does not follow links. A symlinked
 * project therefore hashed differently from its target, so the same directory
 * could need two grants — and a grant on the link covered nothing about the
 * real tree. Under a clone root that gap is worse than clumsy: `<root>/link`
 * pointing at `~/.ssh` is inside the root by spelling and outside it in fact.
 *
 * A path that does not exist cannot be canonicalized; it falls back to
 * `resolve` and simply fails to match at launch time, which is the safe end.
 */
function canonical(p) {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

/**
 * Is `target` strictly below `root`? Both sides already canonical.
 *
 * The root itself is never covered: it is the container the clones live in,
 * not a project. Launching in it would give a writer the whole fan-out —
 * every sibling clone — as its working tree.
 */
function within(root, target) {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function approvalKey({
  project,
  id,
  version,
  checksum,
  permissions,
  command_policy_checksum = null,
  scope = null,
}) {
  const base = {
    project: canonical(project),
    id,
    version,
    checksum,
    permissions,
    command_policy_checksum: command_policy_checksum ?? null,
  };
  // The scope field is added only for a root grant, so every exact grant
  // already on file keeps the key it was written under.
  const payload = JSON.stringify(scope ? { ...base, scope } : base);
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/**
 * Approve a specialist for a project, or for every clone under a root.
 *
 * `pipeline` gives each parallel writer its own full clone, so every writer
 * spawn is a new path and — with an exact-path grant — a new permission
 * prompt for a directory that will be deleted afterwards. A clone-root grant
 * keeps everything else about the binding and loosens only the path: the
 * package checksum, the permissions and the project command policy are still
 * measured at `project` and still have to match at launch, so a clone that
 * carries a different policy is refused exactly as an unapproved project is.
 */
export async function approveSpecialist({ idAtVersion, project, cloneRoot = null, env = process.env }) {
  const [id, version] = String(idAtVersion).split("@");
  if (!id || !version) {
    return { ok: false, errors: ["expected <id>@<version>"] };
  }
  // Resolve exact installed id@version. Project pin must not block approving
  // a different installed version before repin (approve-before-repin).
  const entry = resolveInstalled(id, { version, env });
  if (!entry || entry.version !== version) {
    return { ok: false, errors: [`not installed: ${id}@${version}`] };
  }

  // Load that exact entry without project pin override.
  const loaded = loadInstalledManifest(id, {
    version: entry.version,
    checksum: entry.checksum,
    env,
  });
  if (!loaded || loaded.version !== version) {
    return { ok: false, errors: [`not installed: ${id}@${version}`] };
  }

  try {
    verifyInstalledIntegrity(loaded, loaded.manifest);
  } catch (e) {
    return { ok: false, errors: [e.message], code: e.code || "PACKAGE_INTEGRITY_FAILED" };
  }

  let command_policy_checksum = null;
  try {
    ({ checksum: command_policy_checksum } = resolveCommandPolicyForApproval({
      project,
      permissions: loaded.manifest.permissions,
      env,
    }));
  } catch (e) {
    return { ok: false, errors: [e.message], code: e.code || "COMMAND_POLICY_INVALID" };
  }

  // A root is only as narrow as what it holds, and three ways of getting that
  // wrong are visible from here: a root that is not there, a root so wide it
  // is the home or the filesystem, and a root that contains the very project
  // whose policy is being measured — which is not a clone container at all.
  if (cloneRoot) {
    const rootCanon = canonical(cloneRoot);
    const bad = !fs.existsSync(rootCanon)
      ? `clone root does not exist: ${rootCanon}`
      : rootCanon === path.parse(rootCanon).root || rootCanon === canonical(os.homedir())
        ? `clone root is too wide: ${rootCanon}`
        : within(rootCanon, canonical(project))
          ? `clone root contains the approved project: ${rootCanon}`
          : null;
    if (bad) return { ok: false, errors: [bad], code: "CLONE_ROOT_INVALID" };
  }

  const scope = cloneRoot ? "clone_root" : null;
  const key = approvalKey({
    project: cloneRoot ?? project,
    id,
    version: loaded.version,
    checksum: loaded.checksum,
    permissions: loaded.manifest.permissions,
    command_policy_checksum,
    scope,
  });
  const data = loadApprovals(env);
  data.approvals[key] = {
    project: canonical(project),
    ...(cloneRoot ? { scope, clone_root: canonical(cloneRoot) } : {}),
    id,
    version: loaded.version,
    checksum: loaded.checksum,
    permissions: loaded.manifest.permissions,
    command_policy_checksum,
    approved_at: new Date().toISOString(),
  };
  saveApprovals(data, env);
  return { ok: true, key, approval: data.approvals[key] };
}

export function isApproved({
  project,
  id,
  version,
  checksum,
  permissions,
  command_policy_checksum = null,
  env = process.env,
}) {
  const data = loadApprovals(env);
  const fields = { id, version, checksum, permissions, command_policy_checksum };
  if (data.approvals?.[approvalKey({ project, ...fields })]) return true;

  // No exact grant: a clone root may cover this directory. The stored key is
  // recomputed from the launch's own fields, so containment alone proves
  // nothing — version, checksum, permissions and command policy must still be
  // the ones that were approved.
  const target = canonical(project);
  for (const [storedKey, entry] of Object.entries(data.approvals ?? {})) {
    if (entry?.scope !== "clone_root" || !entry.clone_root) continue;
    if (!within(canonical(entry.clone_root), target)) continue;
    const expected = approvalKey({
      project: entry.clone_root,
      ...fields,
      scope: "clone_root",
    });
    if (expected === storedKey) return true;
  }

  // A git worktree is covered by its main checkout's grant — wherever it
  // lives — with every other field unchanged. A worktree whose own policy
  // differs brings a different checksum and so still matches nothing.
  const main = mainCheckoutOf(target);
  return main ? isApproved({ project: main, ...fields, env }) : false;
}

export function listApprovals(env = process.env) {
  return loadApprovals(env);
}
