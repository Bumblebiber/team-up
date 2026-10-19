import "../helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupRunClone, cloneTargets, cloneVerdict, sweepClones } from "../../src/runs/clone-cleanup.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A source repo with one commit on main and a tasks root holding a full clone of it. */
function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tu-clone-")));
  const source = path.join(base, "source");
  const root = path.join(base, "tasks");
  fs.mkdirSync(source);
  fs.mkdirSync(root);
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.email", "t@t");
  git(source, "config", "user.name", "t");
  fs.writeFileSync(path.join(source, "a.txt"), "a\n");
  fs.writeFileSync(path.join(source, ".gitignore"), "node_modules/\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "init");
  const clone = path.join(root, "task-x");
  execFileSync("git", ["clone", "-q", source, clone]);
  git(clone, "config", "user.email", "t@t");
  git(clone, "config", "user.name", "t");
  fs.mkdirSync(path.join(clone, "node_modules"));
  fs.writeFileSync(path.join(clone, "node_modules", "big.js"), "x");
  return { base, source, root, clone, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function commit(clone, file = "b.txt") {
  fs.writeFileSync(path.join(clone, file), `${file}\n`);
  git(clone, "add", file);
  git(clone, "commit", "-qm", file);
}

test("a clean clone with nothing unlanded passes and is removed, untracked records stay", () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.clone, "REVIEW.md"), "kept\n");
    const logs = [];
    const [r] = cleanupRunClone({ runId: "r1", cwd: t.clone }, { root: t.root, log: (l) => logs.push(l) });
    assert.equal(r.removed, true, r.reason);
    assert.deepEqual(fs.readdirSync(t.clone), ["REVIEW.md"]);
    assert.match(logs[0], /clone removed/);
  } finally { t.done(); }
});

test("tracked changes refuse; untracked files alone do not", () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.clone, "new.txt"), "untracked\n");
    assert.equal(cloneVerdict(t.clone, { root: t.root }).ok, true);
    fs.writeFileSync(path.join(t.clone, "a.txt"), "changed\n");
    assert.match(cloneVerdict(t.clone, { root: t.root }).reason, /uncommitted/);
  } finally { t.done(); }
});

test("an unpushed commit refuses, and so does one pushed only to a feature branch", () => {
  const t = setup();
  try {
    commit(t.clone);
    assert.match(cloneVerdict(t.clone, { root: t.root }).reason, /not on origin main/);
    git(t.clone, "push", "-q", "origin", "HEAD:refs/heads/feature");
    assert.match(cloneVerdict(t.clone, { root: t.root }).reason, /not on origin main/);
  } finally { t.done(); }
});

test("a commit merged into origin main passes", () => {
  const t = setup();
  try {
    commit(t.clone);
    git(t.source, "fetch", "-q", t.clone, "HEAD");
    git(t.source, "merge", "-q", "--ff-only", "FETCH_HEAD");
    assert.equal(cloneVerdict(t.clone, { root: t.root }).ok, true);
  } finally { t.done(); }
});

test("a commit cherry-picked onto main counts as landed", () => {
  const t = setup();
  try {
    commit(t.clone);
    const sha = git(t.clone, "rev-parse", "HEAD").trim();
    git(t.source, "fetch", "-q", t.clone, sha);
    git(t.source, "cherry-pick", sha);
    assert.equal(cloneVerdict(t.clone, { root: t.root }).ok, true);
  } finally { t.done(); }
});

test("a stash refuses", () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.clone, "a.txt"), "wip\n");
    git(t.clone, "stash", "-q");
    assert.match(cloneVerdict(t.clone, { root: t.root }).reason, /stash/);
  } finally { t.done(); }
});

test("paths outside the root, and the root itself, are never targets", () => {
  const t = setup();
  try {
    assert.match(cloneVerdict(t.source, { root: t.root }).reason, /outside/);
    assert.match(cloneVerdict(t.root, { root: t.root }).reason, /outside/);
    assert.deepEqual(cloneTargets(t.source, { root: t.root }), []);
    assert.deepEqual(cloneTargets(t.root, { root: t.root }), []);
    const link = path.join(t.root, "link");
    fs.symlinkSync(t.source, link);
    assert.deepEqual(cloneTargets(link, { root: t.root }), []);
  } finally { t.done(); }
});

test("a worktree is refused", () => {
  const t = setup();
  try {
    const wt = path.join(t.root, "wt");
    git(t.source, "worktree", "add", "-q", wt);
    assert.match(cloneVerdict(wt, { root: t.root }).reason, /not a full clone/);
  } finally { t.done(); }
});

test("an active run in the clone refuses, a finished one does not", () => {
  const t = setup();
  try {
    const states = [{ runId: "r2", status: "watching", cwd: t.root + "/task-x" }];
    assert.match(cloneVerdict(t.clone, { root: t.root, states }).reason, /still watching/);
    const done = [{ runId: "r2", status: "done", cwd: t.clone }];
    assert.equal(cloneVerdict(t.clone, { root: t.root, states: done }).ok, true);
  } finally { t.done(); }
});

test("a non-git task dir is kept; the clone below it is the target", () => {
  const t = setup();
  try {
    const task = path.join(t.root, "task-y");
    fs.mkdirSync(task);
    fs.writeFileSync(path.join(task, "RESULT.md"), "r\n");
    fs.renameSync(t.clone, path.join(task, "repo"));
    const [r] = cleanupRunClone({ runId: "r3", cwd: task }, { root: t.root, log: () => {} });
    assert.equal(r.removed, true, r.reason);
    assert.deepEqual(fs.readdirSync(task), ["RESULT.md"]);
  } finally { t.done(); }
});

test("a symlink inside the clone pointing outside is unlinked, its target survives", () => {
  const t = setup();
  try {
    const outside = path.join(t.base, "precious");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "f"), "x");
    fs.symlinkSync(outside, path.join(t.clone, "node_modules", "link"));
    const [r] = cleanupRunClone({ runId: "r4", cwd: t.clone }, { root: t.root, log: () => {} });
    assert.equal(r.removed, true, r.reason);
    assert.equal(fs.readFileSync(path.join(outside, "f"), "utf8"), "x");
  } finally { t.done(); }
});

test("sweep is a dry run by default and skips clones without an outcome", () => {
  const t = setup();
  try {
    const other = path.join(t.root, "task-z");
    execFileSync("git", ["clone", "-q", t.source, other]);
    const states = [
      { runId: "a", status: "done", cwd: t.clone, outcome: { value: "merged" } },
      { runId: "b", status: "done", cwd: other },
    ];
    const rows = sweepClones({ root: t.root, states, size: () => 1 });
    assert.deepEqual(rows.map((r) => r.kind).sort(), ["no_outcome", "would_remove"]);
    assert.ok(fs.existsSync(path.join(t.clone, ".git")));
  } finally { t.done(); }
});

test("by default cleanup covers ~/.team-up/clones and the legacy ~/projects/tasks", () => {
  const t = setup();
  // Both live under the preload's scratch TEAM_UP_HOME and HOME.
  const clones = [path.join(process.env.TEAM_UP_HOME, "clones"), path.join(os.homedir(), "projects", "tasks")]
    .map((root, i) => path.join(root, `task-${i}`));
  try {
    for (const clone of clones) execFileSync("git", ["clone", "-q", t.source, clone]);
    const states = clones.map((cwd, i) => ({ runId: `d${i}`, status: "done", cwd, outcome: { value: "merged" } }));
    const rows = sweepClones({ states, size: () => 1 });
    assert.deepEqual(rows.map((r) => [r.kind, r.dir]).sort(), clones.map((c) => ["would_remove", c]).sort());
    const [r] = cleanupRunClone(states[1], { log: () => {} });
    assert.equal(r.removed, true, r.reason);
  } finally {
    t.done();
    for (const clone of clones) fs.rmSync(clone, { recursive: true, force: true });
  }
});

test("state writes still work once the run's clone is gone", async () => {
  const t = setup();
  try {
    const runs = await import("../../src/runs/runs.mjs");
    const state = runs.createRun({ cwd: t.clone, role: "implementer", parent: { cli: "claude" }, worker: { cli: "claude" }, prompt: "x" });
    runs.setStatus(state.runId, "done");
    process.env.TEAM_UP_TASKS_ROOT = t.root;
    try {
      runs.setOutcome(state.runId, "merged");
    } finally { delete process.env.TEAM_UP_TASKS_ROOT; }
    assert.equal(fs.existsSync(t.clone), false);
    assert.ok(runs.markCollected(state.runId).collected);
  } finally { t.done(); }
});

test("a linked worktree refuses until it is gone", () => {
  const t = setup();
  try {
    const wt = path.join(t.clone, ".worktrees", "w");
    git(t.clone, "worktree", "add", "-q", wt);
    assert.match(cloneVerdict(t.clone, { root: t.root }).reason, /linked worktrees/);
    fs.rmSync(wt, { recursive: true });
    assert.equal(cloneVerdict(t.clone, { root: t.root }).ok, true);
  } finally { t.done(); }
});

test("a commit on a deleted worktree's detached HEAD keeps the clone", () => {
  const t = setup();
  try {
    const wt = path.join(t.clone, ".worktrees", "d");
    git(t.clone, "worktree", "add", "-q", "--detach", wt);
    commit(wt, "only-here.txt");
    fs.rmSync(wt, { recursive: true });
    assert.match(cloneVerdict(t.clone, { root: t.root }).reason, /not on origin main/);
  } finally { t.done(); }
});

test("ignored work output is kept; only regenerable ignored paths go", () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.clone, ".git", "info", "exclude"), ".team-up/\n.env\ndist/\n*.tsbuildinfo\ndata/**\n");
    for (const f of [".team-up/TICKET.md", ".env", "dist/out.js", "app.tsbuildinfo", "data/save.json", "data/sub/x.json"]) {
      fs.mkdirSync(path.dirname(path.join(t.clone, f)), { recursive: true });
      fs.writeFileSync(path.join(t.clone, f), "x");
    }
    const [r] = cleanupRunClone({ runId: "r5", cwd: t.clone }, { root: t.root, log: () => {} });
    assert.equal(r.removed, true, r.reason);
    assert.deepEqual(fs.readdirSync(t.clone).sort(), [".env", ".team-up", "data"]);
    assert.ok(fs.existsSync(path.join(t.clone, ".team-up", "TICKET.md")));
    assert.ok(fs.existsSync(path.join(t.clone, "data", "sub", "x.json")));
  } finally { t.done(); }
});

test("an unlanded merge commit or a tag origin lacks refuses; a tag origin has does not", () => {
  const t = setup();
  try {
    git(t.clone, "checkout", "-qb", "side");
    commit(t.clone);
    git(t.clone, "checkout", "-q", "main");
    git(t.source, "fetch", "-q", t.clone, "side");
    git(t.source, "merge", "-q", "--ff-only", "FETCH_HEAD");
    git(t.clone, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    assert.match(cloneVerdict(t.clone, { root: t.root }).reason, /unlanded merge/);
    git(t.clone, "reset", "-q", "--hard", "origin/main");
    git(t.clone, "branch", "-qD", "side");
    commit(t.clone, "c.txt");
    git(t.clone, "tag", "-a", "-m", "v1", "v1");
    git(t.clone, "reset", "-q", "--hard", "HEAD~1");
    assert.match(cloneVerdict(t.clone, { root: t.root }).reason, /not on origin main/);
    git(t.clone, "push", "-q", "origin", "v1");
    assert.equal(cloneVerdict(t.clone, { root: t.root }).ok, true);
  } finally { t.done(); }
});

// Run alone (no npm preload) this file once logged r1/r3/r4 into the live
// ~/.team-up/clone-cleanup.log and left a run in the live runs dir.
test("run alone, this file never writes the invoking user's team-up home", () => {
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), "tu-sentinel-home-"));
  try {
    fs.mkdirSync(path.join(sentinel, ".team-up"));
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^a clean clone", fileURLToPath(import.meta.url)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: sentinel },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^# pass 1$/m);
    assert.deepEqual(fs.readdirSync(path.join(sentinel, ".team-up")), []);
  } finally { fs.rmSync(sentinel, { recursive: true, force: true }); }
});
