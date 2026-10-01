#!/usr/bin/env node
// run-merge-check.mjs — did a done run's commits land on the target's main?
//
//   node scripts/run-merge-check.mjs [--apply] [--all] [--json]
//
// Looks at done runs with a git cwd and a base_commit. The run's commits are
// base..head_commit; runs from before head_commit was recorded fall back to
// the commits in base..HEAD made inside the run's time window (clones are
// reused across runs). The target is the clone's origin; a local path is read
// in place, a URL origin is fetched.
//
// A commit counts as landed by ancestry (ff / merge commit), by its own
// patch-id (cherry-pick, rebase) or when the whole range's diff matches one
// commit on main (squash). --apply records `outcome merged` for fully landed
// runs. "discarded" is never derived: an unmerged branch may still land.
// --all also re-checks runs that already have an outcome.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listAllStates, setOutcome } from "../src/runs/runs.mjs";

const BIG = 256 * 1024 * 1024;

function git(cwd, args, input) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", input, maxBuffer: BIG });
  return r.status === 0 ? r.stdout.trim() : null;
}

function patchIds(cwd, args) {
  const patch = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: BIG }).stdout || "";
  if (!patch) return new Set();
  const ids = git(cwd, ["patch-id", "--stable"], patch) || "";
  return new Set(ids.split("\n").filter(Boolean).map((l) => l.split(" ")[0]));
}

/** Where the clone's work is supposed to land: a repo dir plus its main refs. */
function resolveTarget(clone) {
  const origin = git(clone, ["remote", "get-url", "origin"]);
  if (!origin) return null;
  let repo = clone;
  let candidates = ["refs/remotes/origin/main", "refs/remotes/origin/master"];
  if (fs.existsSync(path.resolve(clone, origin))) {
    repo = path.resolve(clone, origin);
    candidates = ["refs/heads/main", "refs/heads/master", ...candidates];
  } else {
    git(clone, ["fetch", "-q", "origin"]);
  }
  const refs = candidates.filter((ref) => git(repo, ["rev-parse", "-q", "--verify", ref]));
  return refs.length ? { repo, refs } : null;
}

export function runCommits(state) {
  const head = state.head_commit || "HEAD";
  const lines = git(state.cwd, ["log", "--format=%H %ct", `${state.base_commit}..${head}`]);
  if (lines === null) return null;
  let commits = lines.split("\n").filter(Boolean).map((l) => {
    const [sha, ct] = l.split(" ");
    return { sha, at: Number(ct) * 1000 };
  });
  if (!state.head_commit) {
    // ponytail: legacy runs are attributed by commit time; two overlapping runs
    // in one clone can mis-assign. Runs that recorded head_commit are exact.
    const from = new Date(state.createdAt).getTime() - 60_000;
    const to = new Date(state.finishedAt || state.updatedAt).getTime() + 10 * 60_000;
    commits = commits.filter((c) => c.at >= from && c.at <= to);
  }
  return commits.map((c) => c.sha); // newest first
}

export function checkRun(state) {
  if (!state.base_commit || !state.cwd || !fs.existsSync(state.cwd)) return { verdict: "no_git" };
  const commits = runCommits(state);
  if (commits === null) return { verdict: "no_git" };
  if (!commits.length) return { verdict: "no_commits" };
  const target = resolveTarget(state.cwd);
  if (!target) return { verdict: "no_target", commits: commits.length };

  const landed = new Set();
  const how = new Set();
  for (const sha of commits) {
    const isAncestor = target.refs.some(
      (ref) => spawnSync("git", ["-C", target.repo, "merge-base", "--is-ancestor", sha, ref]).status === 0,
    );
    if (isAncestor) {
      landed.add(sha);
      how.add("ancestry");
    }
  }
  if (landed.size < commits.length) {
    const since = new Date(new Date(state.createdAt).getTime() - 86400_000).toISOString();
    const onMain = new Set();
    for (const ref of target.refs) {
      for (const id of patchIds(target.repo, ["log", "-p", "--no-merges", `--since=${since}`, ref])) onMain.add(id);
    }
    for (const sha of commits) {
      if (landed.has(sha)) continue;
      const [id] = patchIds(state.cwd, ["show", "--format=", sha]);
      if (id && onMain.has(id)) {
        landed.add(sha);
        how.add("patch-id");
      }
    }
    if (landed.size < commits.length) {
      const [rangeId] = patchIds(state.cwd, ["diff", `${commits.at(-1)}^`, commits[0]]);
      if (rangeId && onMain.has(rangeId)) {
        for (const sha of commits) landed.add(sha);
        how.add("squash");
      }
    }
  }
  const verdict = landed.size === commits.length ? "merged" : landed.size ? "partial" : "unmerged";
  return { verdict, commits: commits.length, landed: landed.size, how: [...how], target: `${target.repo} ${target.refs[0]}` };
}

function main(argv) {
  const apply = argv.includes("--apply");
  const all = argv.includes("--all");
  const rows = [];
  for (const state of listAllStates({ onCorrupt: () => {} })) {
    if (state.status !== "done" || (!all && state.outcome?.value)) continue;
    let result;
    try {
      result = checkRun(state);
    } catch (e) {
      result = { verdict: "error", error: e.message };
    }
    if (apply && result.verdict === "merged" && !state.outcome?.value) {
      setOutcome(state.runId, "merged", { note: `auto: ${result.how.join("+")} into ${result.target}` });
      result.applied = true;
    }
    rows.push({ runId: state.runId, role: state.role, cwd: state.cwd, ...result });
  }
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  for (const r of rows.filter((x) => ["merged", "partial", "unmerged"].includes(x.verdict))) {
    console.log(`${r.verdict.padEnd(8)} ${r.runId} ${r.landed}/${r.commits} ${r.how.join("+") || "-"} ${r.cwd}${r.applied ? " [outcome set]" : ""}`);
  }
  console.log(Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(" · "));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
