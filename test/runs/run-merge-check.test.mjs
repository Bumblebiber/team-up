import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRun } from "../../scripts/run-merge-check.mjs";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }).trim();

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-merge-"));
  const target = path.join(root, "target");
  fs.mkdirSync(target);
  git(target, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(target, "a.txt"), "a\n");
  git(target, "add", ".");
  git(target, "commit", "-qm", "base");
  const clone = path.join(root, "clone");
  execFileSync("git", ["clone", "-q", target, clone], { env });
  git(clone, "switch", "-qc", "feat");
  const base = git(clone, "rev-parse", "HEAD");
  for (const n of ["b", "c"]) {
    fs.writeFileSync(path.join(clone, `${n}.txt`), `${n}\n`);
    git(clone, "add", ".");
    git(clone, "commit", "-qm", n);
  }
  const state = {
    runId: "r", status: "done", cwd: clone, base_commit: base, head_commit: git(clone, "rev-parse", "HEAD"),
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
  };
  return { root, target, clone, state };
}

test("a branch nobody merged is unmerged; merging it flips the verdict", () => {
  const { root, target, clone, state } = setup();
  try {
    assert.equal(checkRun(state).verdict, "unmerged");
    git(target, "pull", "-q", "--ff-only", clone, "feat");
    const r = checkRun(state);
    assert.equal(r.verdict, "merged");
    assert.deepEqual(r.how, ["ancestry"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a squash merge is recognised by the range diff", () => {
  const { root, target, clone, state } = setup();
  try {
    git(target, "fetch", "-q", clone, "feat");
    git(target, "merge", "-q", "--squash", "FETCH_HEAD");
    git(target, "commit", "-qm", "squashed");
    const r = checkRun(state);
    assert.equal(r.verdict, "merged");
    assert.deepEqual(r.how, ["squash"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a run without commits has nothing to merge", () => {
  const { root, state } = setup();
  try {
    assert.equal(checkRun({ ...state, head_commit: state.base_commit }).verdict, "no_commits");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
