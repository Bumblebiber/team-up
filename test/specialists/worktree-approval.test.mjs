import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installPackage } from "../../src/specialists/store.mjs";
import { approveSpecialist, isApproved } from "../../src/specialists/approvals.mjs";
import { resolveCommandPolicyForApproval } from "../../src/commands/policy.mjs";
import { mainCheckoutOf } from "../../src/specialists/worktree.mjs";

const PERMISSIONS = { filesystem: "project_readonly", writes: false, network: false, commands: ["project-test"] };
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
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tu-wt-")));
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

async function install(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-wt-home-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-wt-pkg-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pkg, { recursive: true, force: true });
  });
  const env = { ...process.env, TEAM_UP_HOME: home, TEAM_UP_RUNS: path.join(home, "runs") };
  write(path.join(pkg, "specialist.json"), {
    schema_version: 1,
    id: "testing.wt",
    display_name: "WT",
    version: "0.1.0",
    remit: ["x"],
    anti_remit: ["y"],
    call_types: ["consult"],
    accepted_inputs: ["task_description"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: ["command.test"], mcps: [], frameworks: [] },
    permissions: PERMISSIONS,
    budget: { timeout_seconds: 60 },
    model_profile: { tier: "medium", reasoning: "low" },
    eval_suite: "evals/evals.json",
  });
  write(path.join(pkg, "instructions.md"), "hi\n");
  write(path.join(pkg, "evals", "evals.json"), "[]");
  const res = await installPackage(pkg, env);
  assert.equal(res.ok, true, JSON.stringify(res));
  return { env, checksum: res.checksum ?? res.entry?.checksum };
}

/** What the launcher asks, in the order it asks it. */
function launchApproved(project, env) {
  const { checksum } = resolveCommandPolicyForApproval({ project, permissions: PERMISSIONS, env });
  const installed = JSON.parse(fs.readFileSync(path.join(env.TEAM_UP_HOME, "specialists-index.json"), "utf8"))
    .specialists["testing.wt"];
  return isApproved({
    project,
    id: "testing.wt",
    version: "0.1.0",
    checksum: installed.checksum,
    permissions: PERMISSIONS,
    command_policy_checksum: checksum,
    env,
  });
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
  // Points at a real worktree entry, but that entry links back elsewhere.
  write(path.join(fake, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "real")}\n`);
  assert.equal(mainCheckoutOf(fake), null);
  // Points at a gitdir of its own making outside the main repo.
  const own = path.join(base, "own-gitdir");
  write(path.join(own, "gitdir"), path.join(fake, ".git"));
  write(path.join(own, "commondir"), path.join(main, ".git"));
  write(path.join(fake, ".git"), `gitdir: ${own}\n`);
  assert.equal(mainCheckoutOf(fake), null);
});

test("a worktree from before the policy runs under the main checkout's policy and grant", async (t) => {
  const { base, main } = repo(t);
  const { env } = await install(t);
  assert.equal((await approveSpecialist({ idAtVersion: "testing.wt@0.1.0", project: main, env })).ok, true);
  const wt = path.join(base, "old");
  git(main, "worktree", "add", "-q", "-b", "old", wt, "HEAD~1");
  assert.equal(fs.existsSync(path.join(wt, ".team-up", "commands.json")), false);
  assert.equal(launchApproved(wt, env), true);
});

test("a worktree with the same policy of its own is covered", async (t) => {
  const { base, main } = repo(t);
  const { env } = await install(t);
  await approveSpecialist({ idAtVersion: "testing.wt@0.1.0", project: main, env });
  const wt = path.join(base, "same");
  git(main, "worktree", "add", "-q", wt);
  assert.equal(launchApproved(wt, env), true);
});

test("a worktree that changes the policy needs its own approval", async (t) => {
  const { base, main } = repo(t);
  const { env } = await install(t);
  await approveSpecialist({ idAtVersion: "testing.wt@0.1.0", project: main, env });
  const wt = path.join(base, "changed");
  git(main, "worktree", "add", "-q", wt);
  const changed = structuredClone(POLICY);
  changed.commands["project-test"].argv = ["npm", "run", "anything"];
  fs.chmodSync(path.join(wt, ".team-up", "commands.json"), 0o644);
  write(path.join(wt, ".team-up", "commands.json"), changed);
  assert.equal(launchApproved(wt, env), false);
});

test("an unapproved main checkout approves none of its worktrees", async (t) => {
  const { base, main } = repo(t);
  const { env } = await install(t);
  const wt = path.join(base, "wt");
  git(main, "worktree", "add", "-q", wt);
  assert.equal(launchApproved(wt, env), false);
});
