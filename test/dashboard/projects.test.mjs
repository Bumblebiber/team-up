import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listProjects,
  startProjectSession,
  projectSessionName,
} from "../../src/dashboard/projects.mjs";

const ROSTER = { clis: { claude: { cmd: ["claude", "--model", "{model}", "{prompt}"] } } };

/** A collecting folder inside the real home dir — the homedir check is the
 *  boundary, so a tmpdir outside it would be rejected for the right reason. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.homedir(), ".teamup-test-projects-"));
  fs.mkdirSync(path.join(root, "alpha", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "beta"));
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.writeFileSync(path.join(root, "a-file"), "x");
  return root;
}

test("listProjects lists subdirectories, skips files and dot-dirs", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { projects } = listProjects(root, { exec: () => "", sessions: [] });
  assert.deepEqual(projects.map((p) => p.name), ["alpha", "beta"]);
  assert.equal(projects[0].git, true);
  assert.equal(projects[1].git, false);
});

test("listProjects reports the project's own tmux sessions", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = ["team-up-proj-alpha-claude", "team-up-proj-beta-codex", "team-up-pass-x"];
  const { projects } = listProjects(root, { exec: () => "", sessions });
  assert.deepEqual(projects[0].sessions, ["team-up-proj-alpha-claude"]);
  assert.deepEqual(projects[1].sessions, ["team-up-proj-beta-codex"]);
});

test("a collecting folder outside the home directory is refused", () => {
  assert.throws(() => listProjects("/etc", { exec: () => "" }), /home directory/);
});

test("a symlink pointing out of the home directory is refused", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const link = path.join(root, "escape");
  fs.symlinkSync("/etc", link);
  assert.throws(() => listProjects(link, { exec: () => "" }), /home directory/);
});

test("startProjectSession spawns the bare binary, no worker flag", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const res = startProjectSession({
    dir: path.join(root, "alpha"),
    cli: "claude",
    projectsDir: root,
    roster: ROSTER,
    sessions: [],
    exec: (cmd, args) => calls.push([cmd, args]),
  });
  assert.equal(res.ok, true);
  assert.equal(res.session, "team-up-proj-alpha-claude");
  const [cmd, args] = calls[0];
  assert.equal(cmd, "tmux");
  assert.deepEqual(args.slice(0, 6), ["new-session", "-d", "-s", res.session, "-c", fs.realpathSync(path.join(root, "alpha"))]);
  assert.equal(args.at(-1), "claude");
  assert.ok(!args.join(" ").includes("TEAMUP_WORKER"));
});

test("an already running session is opened, not started twice", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const res = startProjectSession({
    dir: path.join(root, "alpha"),
    cli: "claude",
    projectsDir: root,
    roster: ROSTER,
    sessions: ["team-up-proj-alpha-claude"],
    exec: () => calls.push("spawned"),
  });
  assert.deepEqual(res, { ok: true, session: "team-up-proj-alpha-claude", existing: true });
  assert.deepEqual(calls, []);
});

test("a project outside the collecting folder is refused", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of [os.homedir(), path.join(root, "alpha", ".git"), "/etc"]) {
    const res = startProjectSession({
      dir,
      cli: "claude",
      projectsDir: root,
      roster: ROSTER,
      sessions: [],
      exec: () => assert.fail(`spawned for ${dir}`),
    });
    assert.equal(res.ok, false);
  }
});

test("an unknown cli is refused before anything is spawned", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const res = startProjectSession({
    dir: path.join(root, "alpha"),
    cli: "sh",
    projectsDir: root,
    roster: ROSTER,
    sessions: [],
    exec: () => assert.fail("spawned"),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown cli/);
});

test("a dot in a project name survives into the session name as tmux writes it", () => {
  assert.equal(projectSessionName("foo.bar", "claude"), "team-up-proj-foo-bar-claude");
});
