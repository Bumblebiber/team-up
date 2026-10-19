// A run's real project. Most runs work in a clone — spender clones under
// ~/.team-up/spender/clones, task clones under ~/projects/tasks — whose path
// names no project, so the Inbox and the Runs table resolve it the same way:
// the run's own label or path, its cwd, the spender ledger, the clone's origin
// remote, and last the cwd's basename.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { teamUpHome } from "../paths.mjs";
import { resolveCollectingDir } from "./projects.mjs";
import { projectDirs } from "./tim.mjs";

const GIT_TIMEOUT_MS = 2000;
// Repos come and go rarely; the 1 s view memo would otherwise rescan them every poll.
const FOLDER_TTL_MS = 60_000;
const ORIGINS_TTL_MS = 10 * 60_000;

const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);

/** The usage-spender's ledger file — same precedence as scripts/usage-spender.py OUT_ROOT. */
export function spenderLedgerPath(env = process.env) {
  const reports = env.TEAM_UP_REPORT_DIR || env.O9K_REPORT_DIR || path.join(teamUpHome(env), "reports");
  return path.join(reports, "usage-spender", "ledger.json");
}

let ledgerCache = { file: null, mtimeMs: null, byRun: new Map() };

/** run id → the spender's ledger entry (repo, title, parked, …); empty when the spender never ran. */
export function readSpenderLedger(env = process.env) {
  const file = spenderLedgerPath(env);
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return new Map();
  }
  if (ledgerCache.file !== file || ledgerCache.mtimeMs !== mtimeMs) {
    let entries = [];
    try {
      entries = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { /* mid-write or broken: no entries this time */ }
    const byRun = new Map((Array.isArray(entries) ? entries : []).filter((e) => e?.run_id).map((e) => [e.run_id, e]));
    ledgerCache = { file, mtimeMs, byRun };
  }
  return ledgerCache.byRun;
}

/** An origin URL as a comparable key: a local path as is, else host/owner/name in lower case. */
export function originKey(url) {
  const u = String(url || "").trim();
  if (!u) return null;
  if (u.startsWith("file://")) return path.resolve(u.slice(7));
  if (path.isAbsolute(u)) return path.resolve(u);
  const m = u.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * `(collecting folder) → (run state) → { label, name } | null`. Caches live in
 * the returned function: one per dashboard server. A git call is bounded and
 * made once per cwd, and never for a cwd that is gone (a merged run's clone).
 */
export function createProjectResolver({ exec = execFileSync, env = process.env, now = Date.now } = {}) {
  const origins = new Map();
  const folders = new Map();

  const originOf = (dir) => {
    if (!origins.has(dir)) {
      let key = null;
      if (fs.existsSync(dir)) {
        try {
          key = originKey(exec("git", ["-C", dir, "remote", "get-url", "origin"], {
            encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"],
          }));
        } catch { /* no remote, not a repo, or git too slow */ }
      }
      origins.set(dir, key);
    }
    return origins.get(dir);
  };

  /** Every repo directly in the collecting folder: dir → TIM label, or null without a marker. */
  const folderOf = (dirInput) => {
    let dir;
    try {
      dir = resolveCollectingDir(dirInput);
    } catch {
      return { repos: new Map() }; // a bad collecting-folder pref: resolution falls back to names
    }
    let f = folders.get(dir);
    if (!f || now() - f.at > FOLDER_TTL_MS) {
      const repos = new Map();
      try {
        for (const [label, d] of Object.entries(projectDirs(dir))) repos.set(d, label);
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          if (!name.startsWith(".") && !repos.has(full) && fs.existsSync(path.join(full, ".git"))) repos.set(full, null);
        }
      } catch { /* unreadable folder: no repos */ }
      // The same repos keep their origins and the origins' own 10-minute clock.
      const same = f && f.repos.size === repos.size && [...repos].every(([d, label]) => f.repos.get(d) === label);
      f = { at: now(), repos, byOrigin: same ? f.byOrigin : null, originsAt: same ? f.originsAt : 0 };
      folders.set(dir, f);
    }
    return f;
  };

  /** A clone's origin → the repo in the collecting folder with that origin; a TIM project wins a tie. */
  const repoByOrigin = (f, key) => {
    if (!key) return null;
    if (path.isAbsolute(key)) return [...f.repos.keys()].find((d) => inside(key, d)) ?? null;
    if (!f.byOrigin || now() - f.originsAt > ORIGINS_TTL_MS) {
      for (const d of f.repos.keys()) origins.delete(d);
      f.byOrigin = new Map();
      f.originsAt = now();
      for (const [d, label] of f.repos) {
        const k = originOf(d);
        if (k && (!f.byOrigin.has(k) || (label && !f.repos.get(f.byOrigin.get(k))))) f.byOrigin.set(k, d);
      }
    }
    return f.byOrigin.get(key) ?? null;
  };

  return function projectsIn(dirInput, { ledger = readSpenderLedger(env) } = {}) {
    const f = folderOf(dirInput);
    const holding = (p) => [...f.repos.keys()].find((d) => inside(p, d)) ?? null;
    return function projectOf(state) {
      const project = typeof state?.project === "string" ? state.project.trim() : "";
      const cwd = typeof state?.cwd === "string" ? state.cwd : "";
      // The ledger before the origin: it names the source repo exactly, without a git call.
      const dir = [...f.repos].find(([, label]) => label && label === project)?.[0]
        ?? (path.isAbsolute(project) ? holding(project) : null)
        ?? (cwd ? holding(cwd) : null)
        ?? (ledger.get(state?.runId)?.repo ? holding(ledger.get(state.runId).repo) : null)
        ?? (cwd ? repoByOrigin(f, originOf(cwd)) : null);
      if (dir) return { label: f.repos.get(dir) ?? null, name: path.basename(dir) };
      if (project && !path.isAbsolute(project)) return { label: /^P\d+$/.test(project) ? project : null, name: project };
      // A task clone's checkout is …/tasks/<task>/repo (or wt, clone): the task names it.
      const p = cwd || project;
      const base = path.basename(/^(?:repo|wt|clone)$/.test(path.basename(p)) ? path.dirname(p) : p);
      return base ? { label: null, name: base } : null;
    };
  };
}
