import "../helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createProjectResolver, originKey } from "../../src/dashboard/run-project.mjs";

const home = process.env.HOME;
const projects = path.join(home, "projects");
const reports = path.join(process.env.TEAM_UP_HOME, "my-reports");

function repo(name, { label, origin } = {}) {
  const dir = path.join(projects, name);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  if (label) fs.writeFileSync(path.join(dir, ".tim-project"), JSON.stringify({ project: label }));
  return [dir, origin];
}

const clone = (...parts) => {
  const dir = path.join(home, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

test("origin keys: a local path as is, a remote as host/owner/name in lower case", () => {
  assert.equal(originKey("git@github.com:Bumblebiber/team-up.git"), "github.com/bumblebiber/team-up");
  assert.equal(originKey("https://github.com/Bumblebiber/team-up/"), "github.com/bumblebiber/team-up");
  assert.equal(originKey("/home/x/projects/tim\n"), "/home/x/projects/tim");
  assert.equal(originKey(""), null);
});

test("a run resolves to its repo: label, path, cwd, ledger, origin, then a name", () => {
  const origins = Object.fromEntries([
    repo("tim", { label: "P0063", origin: "https://github.com/ZF-IT-Automation/tim.git" }),
    repo("team-up", { label: "P0073", origin: "git@github.com:Bumblebiber/team-up.git" }),
    // A second checkout of team-up without a marker: the TIM project wins the origin.
    repo("team-up-copy", { origin: "https://github.com/bumblebiber/TEAM-UP" }),
    repo("SpaceColosseum", { label: "P0065" }),
    repo("golden-task"),
  ]);
  fs.mkdirSync(path.join(projects, "tasks"), { recursive: true });
  const taskClone = clone("projects", "tasks", "fix-sync");
  const spenderClone = clone(".team-up", "spender", "clones", "tim-x");
  const teamUpClone = clone(".team-up", "spender", "clones", "team-up-y");
  Object.assign(origins, {
    [taskClone]: path.join(projects, "tim"),
    [spenderClone]: "https://github.com/zf-it-automation/tim",
    [teamUpClone]: "https://github.com/Bumblebiber/team-up.git",
  });
  fs.mkdirSync(path.join(reports, "usage-spender"), { recursive: true });
  fs.writeFileSync(path.join(reports, "usage-spender", "ledger.json"), JSON.stringify([
    { run_id: "L", repo: path.join(projects, "SpaceColosseum"), title: "Review PR 2" },
  ]));

  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args[1]);
    if (!origins[args[1]]) throw new Error("no origin");
    return `${origins[args[1]]}\n`;
  };
  const projectOf = createProjectResolver({ exec, env: { ...process.env, TEAM_UP_REPORT_DIR: reports } })("");

  const cases = [
    [{ project: "P0063", cwd: "/elsewhere" }, { label: "P0063", name: "tim" }],
    [{ project: path.join(projects, "team-up") }, { label: "P0073", name: "team-up" }],
    [{ cwd: path.join(projects, "team-up", ".worktrees", "x") }, { label: "P0073", name: "team-up" }],
    [{ cwd: taskClone }, { label: "P0063", name: "tim" }],
    [{ cwd: spenderClone }, { label: "P0063", name: "tim" }],
    [{ cwd: teamUpClone }, { label: "P0073", name: "team-up" }],
    [{ runId: "L", cwd: "/gone/clone" }, { label: "P0065", name: "SpaceColosseum" }],
    [{ cwd: path.join(projects, "golden-task") }, { label: null, name: "golden-task" }],
    [{ project: "P0099", cwd: "/x/y" }, { label: "P0099", name: "P0099" }],
    [{ cwd: "/gone/elsewhere" }, { label: null, name: "elsewhere" }],
  ];
  for (const [state, want] of cases) assert.deepEqual(projectOf(state), want, JSON.stringify(state));

  assert.ok(!calls.includes("/gone/clone") && !calls.includes("/gone/elsewhere"), "no git on a clone that is gone");
  const before = calls.length;
  projectOf({ cwd: spenderClone });
  assert.equal(calls.length, before, "one git call per cwd");
});

test("a bad collecting folder resolves to names instead of failing", () => {
  const projectOf = createProjectResolver({ exec: () => "" })("not/absolute");
  assert.deepEqual(projectOf({ cwd: "/a/b" }), { label: null, name: "b" });
  assert.equal(projectOf({}), null);
});

test("the repos' origins are asked once per 10 minutes, though the folder is rescanned every minute", () => {
  repo("tim", { label: "P0063" });
  const clones = [1, 2, 3].map((n) => clone(".team-up", "spender", "clones", `ttl-${n}`));
  const asked = [];
  const exec = (cmd, args) => {
    asked.push(args[1]);
    return `https://github.com/x/${clones.includes(args[1]) ? "tim" : path.basename(args[1])}\n`;
  };
  let t = 0;
  const resolver = createProjectResolver({ exec, now: () => t });
  const repoCalls = () => asked.filter((d) => d.startsWith(projects + path.sep)).length;
  const resolve = (cwd) => resolver("", { ledger: new Map() })({ cwd });

  assert.equal(resolve(clones[0]).name, "tim");
  const first = repoCalls();
  assert.ok(first > 0);
  t = 61_000;
  assert.equal(resolve(clones[1]).name, "tim");
  assert.equal(repoCalls(), first, "a folder rescan keeps the origins");
  t = 10 * 60_000 + 62_000;
  assert.equal(resolve(clones[2]).name, "tim");
  assert.equal(repoCalls(), 2 * first, "after 10 minutes every repo is asked again");
});

test("a task clone that is gone is named by its task, not by its checkout folder", () => {
  const projectOf = createProjectResolver({ exec: () => "" })("");
  assert.deepEqual(projectOf({ cwd: "/gone/projects/tasks/fix-sync/repo" }), { label: null, name: "fix-sync" });
  assert.deepEqual(projectOf({ cwd: "/gone/projects/tasks/fix-sync/wt" }), { label: null, name: "fix-sync" });
});
