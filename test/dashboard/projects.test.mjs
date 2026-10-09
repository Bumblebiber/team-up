import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listProjects,
  startProjectSession,
  projectSessionName,
  proposePolicy,
  projectPolicy,
  writeProjectPolicy,
  trustProjectPolicyForProject,
} from "../../src/dashboard/projects.mjs";
import { validateCommandPolicy } from "../../src/commands/policy.mjs";

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

// ── command policy and trust ─────────────────────────────────────────────

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
}

function tmpProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-proj-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const testAction = (proposal) => proposal.policy.commands["project-test"];

test("a package.json test script is an unambiguous npm test", (t) => {
  const dir = tmpProject(t);
  write(path.join(dir, "package.json"), { scripts: { test: "node --test" } });
  const p = proposePolicy(dir);
  assert.equal(p.auto, true);
  assert.deepEqual(testAction(p).argv, ["npm", "test"]);
  assert.equal(testAction(p).cwd, ".");
  assert.equal(validateCommandPolicy(p.policy).ok, true);
});

test("a node test/ directory is not mistaken for pytest", (t) => {
  const dir = tmpProject(t);
  write(path.join(dir, "package.json"), { scripts: { test: "node --test" } });
  write(path.join(dir, "test", "foo.test.mjs"), "");
  write(path.join(dir, "tests", "fixtures", "a.json"), "{}");
  assert.equal(proposePolicy(dir).auto, true);
});

test("npm's placeholder test script is no test at all", (t) => {
  const dir = tmpProject(t);
  write(path.join(dir, "package.json"), {
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
  });
  assert.equal(proposePolicy(dir), null);
});

test("one nested package runs its tests from its own folder", (t) => {
  const dir = tmpProject(t);
  write(path.join(dir, "fischerp", "package.json"), { scripts: { test: "vitest run" } });
  write(path.join(dir, "node_modules", "x", "package.json"), { scripts: { test: "x" } });
  const p = proposePolicy(dir);
  assert.equal(p.auto, true);
  assert.equal(testAction(p).cwd, "fischerp");
});

test("two nested packages are a proposal, not an auto-create", (t) => {
  const dir = tmpProject(t);
  write(path.join(dir, "api", "package.json"), { scripts: { test: "jest" } });
  write(path.join(dir, "web", "package.json"), { scripts: { test: "vitest" } });
  const p = proposePolicy(dir);
  assert.equal(p.auto, false);
});

test("pytest inside a local .venv is unambiguous", (t) => {
  const dir = tmpProject(t);
  write(path.join(dir, ".venv", "bin", "python"), "");
  write(path.join(dir, ".venv", "bin", "pytest"), "");
  // pytest in the venv alone may be a dependency's; a tests dir says it runs here.
  assert.equal(proposePolicy(dir), null);
  write(path.join(dir, "tests", "test_x.py"), "");
  const p = proposePolicy(dir);
  assert.equal(p.auto, true);
  assert.deepEqual(testAction(p).argv, [".venv/bin/python", "-m", "pytest", "-q"]);
});

test("pytest without a venv is only a proposal", (t) => {
  const dir = tmpProject(t);
  write(path.join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n");
  const p = proposePolicy(dir);
  assert.equal(p.auto, false);
  assert.deepEqual(testAction(p).argv, ["python3", "-m", "pytest", "-q"]);
});

test("npm and venv pytest side by side is ambiguous", (t) => {
  const dir = tmpProject(t);
  write(path.join(dir, "package.json"), { scripts: { test: "node --test" } });
  write(path.join(dir, ".venv", "bin", "python"), "");
  write(path.join(dir, ".venv", "bin", "pytest"), "");
  write(path.join(dir, "tests", "test_x.py"), "");
  assert.equal(proposePolicy(dir).auto, false);
});

test("a repo without tests gets no proposal and state none", (t) => {
  const dir = tmpProject(t);
  write(path.join(dir, "README.md"), "hi");
  assert.equal(proposePolicy(dir), null);
  assert.deepEqual(projectPolicy(dir), { state: "none" });
});

test("policy state reads missing, invalid and valid", (t) => {
  const dir = tmpProject(t);
  write(path.join(dir, "package.json"), { scripts: { test: "node --test" } });
  const missing = projectPolicy(dir);
  assert.equal(missing.state, "missing");
  assert.equal(missing.proposal.auto, true);

  write(path.join(dir, ".team-up", "commands.json"), "{not json");
  assert.equal(projectPolicy(dir).state, "invalid");

  write(path.join(dir, ".team-up", "commands.json"), {
    schema_version: 1,
    commands: { "project-test": { argv: ["bash", "-c", "x"], cwd: ".", timeout_seconds: 1, environment: {} } },
  });
  const invalid = projectPolicy(dir);
  assert.equal(invalid.state, "invalid");
  assert.match(invalid.errors.join(" "), /shell/);

  write(path.join(dir, ".team-up", "commands.json"), missing.proposal.policy);
  assert.deepEqual(projectPolicy(dir), { state: "valid" });
});

test("writeProjectPolicy writes the unambiguous proposal once and never overwrites", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "alpha");
  write(path.join(dir, "package.json"), { scripts: { test: "node --test" } });
  const res = writeProjectPolicy({ dir, projectsDir: root });
  assert.equal(res.ok, true, res.error);
  const target = path.join(dir, ".team-up", "commands.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")).commands["project-test"].argv, ["npm", "test"]);
  const again = writeProjectPolicy({ dir, projectsDir: root });
  assert.equal(again.ok, false);
  assert.match(again.error, /exists/);
});

test("writeProjectPolicy takes an edited policy but validates it", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "beta");
  const bad = { schema_version: 1, commands: { "project-test": { argv: ["sh", "-c", "make"], cwd: ".", timeout_seconds: 60, environment: {} } } };
  const refused = writeProjectPolicy({ dir, projectsDir: root, policy: bad });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /shell/);
  assert.equal(fs.existsSync(path.join(dir, ".team-up")), false);

  const good = { schema_version: 1, commands: { "project-test": { argv: ["make", "test"], cwd: ".", timeout_seconds: 60, environment: {} } } };
  assert.equal(writeProjectPolicy({ dir, projectsDir: root, policy: good }).ok, true);
});

test("without an edited policy only an unambiguous proposal is written", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "beta");
  write(path.join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n");
  const res = writeProjectPolicy({ dir, projectsDir: root });
  assert.equal(res.ok, false);
  assert.equal(fs.existsSync(path.join(dir, ".team-up", "commands.json")), false);
});

test("a symlinked .team-up is not written through", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const elsewhere = tmpProject(t);
  const dir = path.join(root, "beta");
  write(path.join(dir, "package.json"), { scripts: { test: "node --test" } });
  fs.symlinkSync(elsewhere, path.join(dir, ".team-up"));
  const res = writeProjectPolicy({ dir, projectsDir: root });
  assert.equal(res.ok, false);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("writeProjectPolicy refuses a folder outside the collecting folder", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const res = writeProjectPolicy({ dir: path.join(root, "alpha", ".git"), projectsDir: root });
  assert.equal(res.ok, false);
});

// ── command-policy trust ──

test("listProjects shows whether a valid project policy checksum is trusted", (t) => {
  const root = fixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const env = { ...process.env, TEAM_UP_HOME: home };
  const dir = path.join(root, "alpha");
  write(path.join(dir, "package.json"), { scripts: { test: "node --test" } });
  assert.equal(writeProjectPolicy({ dir, projectsDir: root }).ok, true);

  const before = listProjects(root, { exec: () => "", sessions: [], env }).projects
    .find((p) => p.name === "alpha");
  assert.equal(before.policy.state, "valid");
  assert.equal(before.policy.trusted, false);

  const trusted = trustProjectPolicyForProject({ dir, projectsDir: root, env });
  assert.equal(trusted.ok, true, trusted.error);
  const after = listProjects(root, { exec: () => "", sessions: [], env }).projects
    .find((p) => p.name === "alpha");
  assert.equal(after.policy.trusted, true);

  const changed = JSON.parse(fs.readFileSync(path.join(dir, ".team-up", "commands.json"), "utf8"));
  changed.commands["project-test"].timeout_seconds += 1;
  write(path.join(dir, ".team-up", "commands.json"), changed);
  const edited = listProjects(root, { exec: () => "", sessions: [], env }).projects
    .find((p) => p.name === "alpha");
  assert.equal(edited.policy.trusted, false);
});

test("dashboard policy trust refuses a project outside the collecting folder", (t) => {
  const root = fixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const res = trustProjectPolicyForProject({
    dir: os.homedir(), projectsDir: root, env: { ...process.env, TEAM_UP_HOME: home },
  });
  assert.equal(res.ok, false);
});
