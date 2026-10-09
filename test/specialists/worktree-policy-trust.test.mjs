import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isPolicyTrusted, trustProjectPolicy } from "../../src/specialists/approvals.mjs";
import { resolveCommandPolicyForApproval } from "../../src/commands/policy.mjs";
import { mainCheckoutOf } from "../../src/specialists/worktree.mjs";

const PERMISSIONS = { commands: ["project-test"] };
const POLICY = {
  schema_version: 1,
  commands: { "project-test": { argv: ["npm", "test"], cwd: ".", timeout_seconds: 60, environment: {} } },
};

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
}

/** A repo whose first commit has no policy and whose second adds one. */
function repo(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tu-wt-policy-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, "main");
  fs.mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  write(path.join(main, "README.md"), "x");
  git(main, "add", ".");
  git(main, "commit", "-qm", "init");
  write(path.join(main, ".team-up", "commands.json"), POLICY);
  git(main, "add", ".");
  git(main, "commit", "-qm", "policy");
  return { base, main };
}

function policyChecksum(project, env) {
  return resolveCommandPolicyForApproval({ project, permissions: PERMISSIONS, env }).checksum;
}

function policyTrustFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-wt-policy-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { env: { ...process.env, TEAM_UP_HOME: home } };
}

test("mainCheckoutOf finds the main checkout of a real worktree, anywhere", (t) => {
  const { base, main } = repo(t);
  const wt = path.join(base, "elsewhere", "wt");
  git(main, "worktree", "add", "-q", wt);
  assert.equal(mainCheckoutOf(wt), main);
  assert.equal(mainCheckoutOf(main), null);
  assert.equal(mainCheckoutOf(base), null);
});

test("a forged .git file does not make a folder a worktree", (t) => {
  const { base, main } = repo(t);
  git(main, "worktree", "add", "-q", path.join(base, "real"));
  const fake = path.join(base, "fake");
  write(path.join(fake, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "real")}\n`);
  assert.equal(mainCheckoutOf(fake), null);
  const own = path.join(base, "own-gitdir");
  write(path.join(own, "gitdir"), path.join(fake, ".git"));
  write(path.join(own, "commondir"), path.join(main, ".git"));
  write(path.join(fake, ".git"), `gitdir: ${own}\n`);
  assert.equal(mainCheckoutOf(fake), null);
});

test("a worktree without its own policy resolves and trusts the main checkout policy", (t) => {
  const { base, main } = repo(t);
  const { env } = policyTrustFixture(t);
  const wt = path.join(base, "old");
  git(main, "worktree", "add", "-q", "-b", "old", wt, "HEAD~1");
  assert.equal(fs.existsSync(path.join(wt, ".team-up", "commands.json")), false);

  const mainChecksum = policyChecksum(main, env);
  assert.equal(trustProjectPolicy({ project: wt, env }).ok, true);
  assert.equal(policyChecksum(wt, env), mainChecksum);
  assert.equal(isPolicyTrusted({ checksum: mainChecksum, env }), true);
});

test("a changed worktree policy needs its own checksum trust", (t) => {
  const { base, main } = repo(t);
  const { env } = policyTrustFixture(t);
  const wt = path.join(base, "changed");
  git(main, "worktree", "add", "-q", wt);
  const mainChecksum = policyChecksum(main, env);
  assert.equal(trustProjectPolicy({ project: main, env }).ok, true);
  assert.equal(isPolicyTrusted({ checksum: mainChecksum, env }), true);

  const changed = structuredClone(POLICY);
  changed.commands["project-test"].argv = ["npm", "run", "anything"];
  fs.chmodSync(path.join(wt, ".team-up", "commands.json"), 0o644);
  write(path.join(wt, ".team-up", "commands.json"), changed);
  const changedChecksum = policyChecksum(wt, env);
  assert.notEqual(changedChecksum, mainChecksum);
  assert.equal(isPolicyTrusted({ checksum: changedChecksum, env }), false);
  assert.equal(trustProjectPolicy({ project: wt, env }).ok, true);
  assert.equal(isPolicyTrusted({ checksum: changedChecksum, env }), true);
});

test("a worktree policy stays untrusted until explicitly trusted", (t) => {
  const { base, main } = repo(t);
  const { env } = policyTrustFixture(t);
  const wt = path.join(base, "wt");
  git(main, "worktree", "add", "-q", wt);
  assert.equal(isPolicyTrusted({ checksum: policyChecksum(wt, env), env }), false);
});
