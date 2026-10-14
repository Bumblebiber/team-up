// clone-cleanup.mjs — remove a writer's sandbox clone once its run is merged or discarded.
//
// Every clone-per-writer checkout lives under the tasks root (~/projects/tasks).
// Nothing removed them after the merge, and the root grew to ~38 GB of repo
// copies with node_modules. The run's record (STATE, mailbox RESULT.md) lives
// in ~/.team-up/runs and is never touched here. Untracked files in the clone
// (PLAN.md, REVIEW.md, a file nobody added) are kept in place. Only .git,
// tracked files and ignored files (node_modules, .venv, build output) go.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { teamUpHome } from "../paths.mjs";

const TERMINAL = new Set(["done", "failed", "cancelled"]);
const FETCH_TIMEOUT_MS = 20_000;

export function tasksRoot(env = process.env) {
  return env.TEAM_UP_TASKS_ROOT || path.join(os.homedir(), "projects", "tasks");
}

function git(dir, args, { timeout = 10_000 } = {}) {
  const r = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return r.status === 0 ? r.stdout : null;
}

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** True when `child` is strictly below `parent` (both real paths). */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isCloneRoot(dir) {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  return top !== null && real(top.trim()) === dir;
}

/**
 * The clone(s) a run worked in: its cwd when that is a clone root, else the
 * clone roots directly below it (task dir with the clone in a subdir).
 */
export function cloneTargets(cwd, { root = tasksRoot() } = {}) {
  const realRoot = real(root);
  const dir = cwd && real(cwd);
  if (!realRoot || !dir || !isInside(dir, realRoot)) return [];
  if (isCloneRoot(dir)) return [dir];
  if (fs.existsSync(path.join(dir, ".git"))) return []; // a subdir of some repo
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => path.join(dir, e.name))
    .filter(isCloneRoot);
}

/**
 * Commits reachable from HEAD or a local branch that are not on origin's main,
 * neither by ancestry nor by patch-id (cherry-pick, rebase). A commit pushed
 * only to a feature branch is unmerged and counts. So does a squash merge:
 * deleting is only safe when landing is provable.
 */
function unlandedCommits(dir) {
  if (git(dir, ["fetch", "-q", "origin"], { timeout: FETCH_TIMEOUT_MS }) === null) return { error: "fetch from origin failed" };
  const main = ["refs/remotes/origin/main", "refs/remotes/origin/master"]
    .find((ref) => git(dir, ["rev-parse", "-q", "--verify", ref]) !== null);
  if (!main) return { error: "origin has no main or master" };
  const tips = ["HEAD", ...(git(dir, ["for-each-ref", "--format=%(refname)", "refs/heads"]) || "").split("\n").filter(Boolean)];
  const unlanded = new Set();
  for (const tip of tips) {
    const out = git(dir, ["cherry", main, tip]);
    if (out === null) return { error: `git cherry failed for ${tip}` };
    for (const line of out.split("\n")) {
      if (line.startsWith("+ ")) unlanded.add(line.slice(2).trim());
    }
  }
  return { shas: [...unlanded] };
}

/**
 * Whether `dir` may be removed. Every guard refuses; only a clean, fully
 * landed, idle clone strictly inside the tasks root passes.
 */
export function cloneVerdict(dir, { root = tasksRoot(), states = [] } = {}) {
  const realRoot = real(root);
  const target = real(dir);
  if (!realRoot) return { ok: false, reason: "tasks root missing" };
  if (!target) return { ok: false, reason: "missing" };
  if (!isInside(target, realRoot)) return { ok: false, reason: "outside the tasks root" };
  if (!fs.lstatSync(path.join(target, ".git"), { throwIfNoEntry: false })?.isDirectory()) {
    return { ok: false, reason: "not a full clone (.git missing or a worktree gitfile)" };
  }
  if (!isCloneRoot(target)) return { ok: false, reason: "not a git toplevel" };
  if (fs.existsSync(path.join(target, ".git", "objects", "info", "alternates"))) {
    return { ok: false, reason: "shared clone (objects/info/alternates)" };
  }
  for (const s of states) {
    const cwd = s.cwd && real(s.cwd);
    if (!cwd || TERMINAL.has(s.status)) continue;
    if (cwd === target || isInside(cwd, target) || isInside(target, cwd)) {
      return { ok: false, reason: `run ${s.runId} is still ${s.status} there` };
    }
  }
  const dirty = git(target, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty === null) return { ok: false, reason: "git status failed" };
  if (dirty.trim()) return { ok: false, reason: "uncommitted changes to tracked files" };
  const stash = git(target, ["stash", "list"]);
  if (stash === null || stash.trim()) return { ok: false, reason: "has stash entries" };
  const unlanded = unlandedCommits(target);
  if (unlanded.error) return { ok: false, reason: unlanded.error };
  if (unlanded.shas.length) return { ok: false, reason: `${unlanded.shas.length} commit(s) not on origin main` };
  return { ok: true, dir: target };
}

/** Delete the clone but keep its untracked, non-ignored files in place. */
export function removeClone(dir) {
  const out = git(dir, ["ls-files", "-z", "--others", "--exclude-standard", "--directory"]);
  if (out === null) throw new Error(`git ls-files failed in ${dir}`);
  const keep = out.split("\0").filter(Boolean).map((p) => p.replace(/\/$/, ""));
  if (!keep.length) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { kept: [] };
  }
  // Move the keepers aside, drop the clone, move them back. A crash in
  // between leaves them in the staging dir, never deleted.
  const staging = `${dir}.keep-${process.pid}`;
  for (const rel of keep) {
    fs.mkdirSync(path.dirname(path.join(staging, rel)), { recursive: true });
    fs.renameSync(path.join(dir, rel), path.join(staging, rel));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  return { kept: keep };
}

export function logCleanup(entry, env = process.env) {
  try {
    fs.appendFileSync(path.join(teamUpHome(env), "clone-cleanup.log"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* the log is a convenience; stderr already has the line */ }
}

/**
 * Called when a run gets its outcome. Never throws: recording the outcome
 * must not fail because a clone could not be removed.
 */
export function cleanupRunClone(state, { root = tasksRoot(), states = [], log = console.error } = {}) {
  const results = [];
  try {
    for (const dir of cloneTargets(state.cwd, { root })) {
      const verdict = cloneVerdict(dir, { root, states });
      if (!verdict.ok) {
        results.push({ dir, removed: false, reason: verdict.reason });
        log(`clone kept: ${dir} (${verdict.reason})`);
        continue;
      }
      const { kept } = removeClone(verdict.dir);
      results.push({ dir, removed: true, kept });
      log(`clone removed: ${dir}${kept.length ? ` (kept ${kept.join(", ")})` : ""}`);
    }
  } catch (error) {
    results.push({ dir: state.cwd, removed: false, reason: `error: ${error.message}` });
    log(`clone cleanup failed for ${state.cwd}: ${error.message}`);
  }
  for (const r of results) logCleanup({ runId: state.runId, outcome: state.outcome?.value, ...r });
  return results;
}

function duBytes(dir) {
  const r = spawnSync("du", ["-sb", dir], { encoding: "utf8" });
  return r.status === 0 ? Number(r.stdout.split("\t")[0]) : 0;
}

/**
 * Backlog sweep: every clone under the tasks root whose runs are all finished
 * and at least one has an outcome. Dry run unless `apply`.
 */
export function sweepClones({ root = tasksRoot(), states = [], apply = false, size = duBytes } = {}) {
  const byTarget = new Map();
  for (const s of states) {
    for (const dir of cloneTargets(s.cwd, { root })) {
      if (!byTarget.has(dir)) byTarget.set(dir, []);
      byTarget.get(dir).push(s);
    }
  }
  const rows = [];
  for (const [dir, runs] of byTarget) {
    const bytes = size(dir);
    if (!runs.some((s) => s.outcome?.value === "merged" || s.outcome?.value === "discarded")) {
      rows.push({ dir, bytes, kind: "no_outcome" });
      continue;
    }
    const verdict = cloneVerdict(dir, { root, states });
    if (!verdict.ok) {
      rows.push({ dir, bytes, kind: "kept", reason: verdict.reason });
      continue;
    }
    if (apply) {
      const { kept } = removeClone(verdict.dir);
      logCleanup({ sweep: true, dir, removed: true, kept, bytes });
      rows.push({ dir, bytes, kind: "removed", kept });
    } else {
      rows.push({ dir, bytes, kind: "would_remove" });
    }
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}
