import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackage } from "../../src/specialists/store.mjs";
import { buildTimView, defaultPrompt, projectDirs, promptClis, startTaskSession, taskSessionName } from "../../src/dashboard/tim.mjs";

const ROSTER = { clis: { claude: { cmd: ["claude", "--model", "{model}", "{prompt}"] } } };

const WORK = {
  projects: [{ label: "P0001", title: "Alpha" }, { label: "P0002", title: "Beta" }],
  items: [
    { id: "e-1", kind: "task", title: "do it", status: "todo", priority: "P1", project: "P0001" },
    { id: "e-2", kind: "bug", title: "broken", status: "open", priority: null, project: "P0001" },
    { id: "e-3", kind: "idea", title: "what if", status: "new", priority: null, project: "P0002" },
  ],
};

/** A collecting folder inside the real home dir — the homedir check is the boundary. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.homedir(), ".teamup-test-tim-"));
  fs.mkdirSync(path.join(root, "alpha"));
  fs.writeFileSync(path.join(root, "alpha", ".tim-project"), JSON.stringify({ version: 3, project: "P0001" }));
  fs.mkdirSync(path.join(root, "nomarker"));
  return root;
}

/** exec double: `tim open-work` answers, everything else is recorded. */
function execFake(calls, { work = WORK } = {}) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === "tim") {
      if (!work) throw new Error("tim: command not found");
      return JSON.stringify(work);
    }
    return "";
  };
}

test("projectDirs maps labels to the directories carrying the marker", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(projectDirs(root), { P0001: path.join(root, "alpha") });
});

test("buildTimView groups items per project and marks the ones without a repo", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const view = buildTimView(root, { exec: execFake([]), sessions: [] });
  assert.equal(view.installed, true);
  assert.deepEqual(view.projects.map((p) => p.label), ["P0001", "P0002"]);
  assert.equal(view.projects[0].dir, path.join(root, "alpha"));
  assert.deepEqual(view.projects[0].items.map((i) => i.kind), ["task", "bug"]);
  assert.equal(view.projects[1].dir, null);
});

test("no tim on PATH hides the panel instead of failing", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const view = buildTimView(root, { exec: execFake([], { work: null }), sessions: [] });
  assert.deepEqual(view, { installed: false, projects: [] });
});

test("a running session is reported on its own entry only", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = [taskSessionName("alpha", "claude", "e-1")];
  const view = buildTimView(root, { exec: execFake([]), sessions });
  const [task, bug] = view.projects[0].items;
  assert.deepEqual(task.sessions, sessions);
  assert.deepEqual(bug.sessions, []);
});

test("startTaskSession spawns the bare binary with the entry in the prompt", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const res = startTaskSession({
    id: "e-1", cli: "claude", projectsDir: root, roster: ROSTER,
    exec: execFake(calls), sessions: [],
  });
  assert.equal(res.ok, true);
  assert.equal(res.session, taskSessionName("alpha", "claude", "e-1"));
  const tmux = calls.find((c) => c.cmd === "tmux");
  assert.equal(tmux.args[tmux.args.indexOf("-c") + 1], path.join(root, "alpha"));
  // The bare binary, not the roster's --dangerously-* template, and the prompt names the entry.
  const command = tmux.args.at(-1);
  assert.match(command, /^claude 'Work on TIM task e-1/);
  assert.match(command, /tim_read\("e-1"\)/);
  assert.ok(tmux.args.includes("TEAMUP_WORKER=1") === false);
});

test("two entries of one project get two sessions", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = taskSessionName("alpha", "claude", "e-1");
  const res = startTaskSession({
    id: "e-2", cli: "claude", projectsDir: root, roster: ROSTER,
    exec: execFake([]), sessions: [first],
  });
  assert.equal(res.existing, false);
  assert.notEqual(res.session, first);
});

test("an already running entry is opened, not spawned twice", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const session = taskSessionName("alpha", "claude", "e-1");
  const res = startTaskSession({
    id: "e-1", cli: "claude", projectsDir: root, roster: ROSTER,
    exec: execFake(calls), sessions: [session],
  });
  assert.deepEqual(res, { ok: true, session, existing: true });
  assert.equal(calls.some((c) => c.cmd === "tmux"), false);
});

test("an id the report does not carry starts nothing", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const res = startTaskSession({
    id: "../../etc", cli: "claude", projectsDir: root, roster: ROSTER,
    exec: execFake(calls), sessions: [],
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.equal(calls.some((c) => c.cmd === "tmux"), false);
});

test("a project without a marker directory cannot start a session", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const res = startTaskSession({
    id: "e-3", cli: "claude", projectsDir: root, roster: ROSTER,
    exec: execFake([]), sessions: [],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /P0002/);
});

test("a title with shell metacharacters stays one quoted argument", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const work = {
    projects: [{ label: "P0001", title: "Alpha" }],
    items: [{ id: "e-9", kind: "task", title: `x'; $(touch /tmp/pwn) #`, status: "todo", priority: null, project: "P0001" }],
  };
  startTaskSession({
    id: "e-9", cli: "claude", projectsDir: root, roster: ROSTER,
    exec: execFake(calls, { work }), sessions: [],
  });
  const command = calls.find((c) => c.cmd === "tmux").args.at(-1);
  assert.equal(command.includes("$(touch /tmp/pwn)'"), false);
  assert.match(command, /\$\(touch \/tmp\/pwn\)/);
  assert.equal(command.startsWith("claude '"), true);
  assert.equal(command.endsWith("'"), true);
});

test("prompt-taking CLIs are offered, including agy's -i form", () => {
  const roster = { clis: { agy: {}, claude: {}, codex: {}, cursor: {}, opencode: {}, hermes: {} } };
  assert.deepEqual(promptClis(roster), ["agy", "claude", "codex", "cursor"]);
});

test("agy task session puts edited prompt after -i", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const res = startTaskSession({
    id: "e-1", cli: "agy", model: "gemini-3.8-flash", prompt: "inspect tests",
    projectsDir: root,
    roster: {
      clis: { agy: { cmd: ["agy", "--model", "{model}", "-i", "{prompt}"] } },
      models: { "gemini-3.8-flash": { cli: ["agy"] } },
    },
    exec: execFake(calls), sessions: [],
  });
  assert.equal(res.ok, true);
  const command = calls.find((call) => call.cmd === "tmux").args.at(-1);
  assert.equal(command, "agy --model gemini-3.8-flash -i 'inspect tests'");
});

test("a CLI that reads its first argument as something else starts nothing", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const res = startTaskSession({
    id: "e-1", cli: "opencode", projectsDir: root,
    roster: { clis: { opencode: { cmd: ["opencode"] } } },
    exec: execFake(calls), sessions: [],
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(calls.some((c) => c.cmd === "tmux"), false);
});

test("an edited prompt is what the session gets", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  startTaskSession({
    id: "e-1", cli: "claude", prompt: "just read the tests", projectsDir: root,
    roster: ROSTER, exec: execFake(calls), sessions: [],
  });
  assert.equal(calls.find((c) => c.cmd === "tmux").args.at(-1), "claude 'just read the tests'");
});

test("an empty prompt falls back to the default", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  startTaskSession({
    id: "e-1", cli: "claude", prompt: "   ", projectsDir: root,
    roster: ROSTER, exec: execFake(calls), sessions: [],
  });
  assert.match(calls.find((c) => c.cmd === "tmux").args.at(-1), /^claude 'Work on TIM task e-1/);
});

test("the view carries the default prompt for the dialog", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const view = buildTimView(root, { exec: execFake([]), sessions: [] });
  assert.equal(view.projects[0].items[0].prompt, defaultPrompt(WORK.items[0]));
});

test("an unknown model is refused before it reaches the CLI", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const res = startTaskSession({
    id: "e-1", cli: "claude", model: "not-in-roster", projectsDir: root,
    roster: ROSTER, exec: execFake(calls), sessions: [],
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(calls.some((c) => c.cmd === "tmux"), false);
});

test("--model carries the CLI's own name for the model, not the roster id", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const roster = {
    ...ROSTER,
    models: { "claude-opus": { tier: "frontier", cli: ["claude"], cli_model: "opus" } },
  };
  startTaskSession({
    id: "e-1", cli: "claude", model: "claude-opus", prompt: "go", projectsDir: root,
    roster, exec: execFake(calls), sessions: [],
  });
  assert.equal(calls.find((c) => c.cmd === "tmux").args.at(-1), "claude --model opus go");
});

test("a model the roster does not run on this CLI is refused", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const res = startTaskSession({
    id: "e-1", cli: "claude", model: "composer", projectsDir: root,
    roster: { ...ROSTER, models: { composer: { tier: "medium", cli: ["cursor"] } } },
    exec: execFake(calls), sessions: [],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /does not run on claude/);
  assert.equal(calls.some((c) => c.cmd === "tmux"), false);
});

test("a specialist that is not installed starts nothing", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const res = startTaskSession({
    id: "e-1", cli: "claude", specialist: "coding.nobody", projectsDir: root,
    roster: ROSTER, env: { TEAM_UP_HOME: root }, exec: execFake(calls), sessions: [],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /not installed/);
  assert.equal(calls.some((c) => c.cmd === "tmux"), false);
});

/** A real installed package: the framing is read from the manifest, not faked. */
async function installedSpecialist(home) {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-tim-pkg-"));
  fs.writeFileSync(path.join(pkg, "specialist.json"), JSON.stringify({
    schema_version: 1,
    id: "coding.codey",
    display_name: "Codey",
    version: "0.1.0",
    remit: ["implementing one ticket against a spec"],
    anti_remit: ["changing the spec"],
    call_types: ["delegate"],
    accepted_inputs: ["task_description"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
    permissions: { filesystem: "project", writes: true, network: false, commands: [] },
    budget: { timeout_seconds: 60, max_tokens: 1000 },
    model_profile: { tier: "frontier", reasoning: "medium" },
    eval_suite: "evals/evals.json",
  }));
  fs.writeFileSync(path.join(pkg, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(pkg, "evals"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "evals", "evals.json"), "[]");
  const env = { ...process.env, TEAM_UP_HOME: home };
  assert.equal((await installPackage(pkg, env)).ok, true);
  fs.rmSync(pkg, { recursive: true, force: true });
  return env;
}

test("a specialist puts its remit in front of the prompt, and says what it is not", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = await installedSpecialist(path.join(root, "home"));
  const calls = [];
  const res = startTaskSession({
    id: "e-1", cli: "claude", specialist: "coding.codey", prompt: "fix the thing",
    projectsDir: root, roster: ROSTER, env, exec: execFake(calls), sessions: [],
  });
  assert.equal(res.ok, true);
  const command = calls.find((c) => c.cmd === "tmux").args.at(-1);
  assert.match(command, /acting as Codey \(coding.codey@0.1.0\)/);
  assert.match(command, /implementing one ticket against a spec/);
  assert.match(command, /changing the spec/);
  // The session must not pass itself off as a sandboxed specialist run.
  assert.match(command, /no RESULT.json is expected/);
  assert.match(command, /fix the thing'$/);
});
