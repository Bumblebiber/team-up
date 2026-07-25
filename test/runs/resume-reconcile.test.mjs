import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as runs from "../../src/runs/runs.mjs";

function withTempRuns(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-resume-reconcile-"));
    const prevTeamUpRuns = process.env.TEAM_UP_RUNS;
    const prevO9kRuns = process.env.O9K_RUNS;
    process.env.TEAM_UP_RUNS = dir;
    delete process.env.O9K_RUNS;
    try {
      await fn(dir);
    } finally {
      if (prevTeamUpRuns === undefined) delete process.env.TEAM_UP_RUNS;
      else process.env.TEAM_UP_RUNS = prevTeamUpRuns;
      if (prevO9kRuns === undefined) delete process.env.O9K_RUNS;
      else process.env.O9K_RUNS = prevO9kRuns;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function createFixture({
  stateStatus = "watching",
  mailboxStatus = stateStatus,
  typed = false,
  parentAttach = "manual",
} = {}) {
  const state = runs.createRun({
    cwd: "/tmp/project",
    role: typed ? "specialist:test" : "implementer",
    parent: {
      cli: "claude",
      attach: parentAttach,
      tmux: parentAttach === "tmux" ? `parent-${Date.now()}-${Math.random()}` : null,
    },
    worker: {
      cli: "codex",
      sessionId: "worker-session",
      tmux: `worker-${Date.now()}-${Math.random()}`,
    },
    prompt: "test task",
    ...(typed ? { result_protocol: "RESULT.json" } : {}),
  });
  runs.setStatus(state.runId, stateStatus);
  runs.atomicWriteText(path.join(runs.mailboxDir(state.runId), "STATUS"), mailboxStatus);
  return runs.loadState(state.runId);
}

function writeTyped(runId, value) {
  const target = path.join(runs.mailboxDir(runId), "RESULT.json");
  if (typeof value === "string") runs.atomicWriteText(target, value);
  else runs.atomicWriteJson(target, value);
}

test("classifyMailbox recognizes cancelled as terminal", withTempRuns(async () => {
  const state = createFixture({ stateStatus: "watching", mailboxStatus: "cancelled" });
  assert.deepEqual(runs.classifyMailbox(state.runId), { status: "cancelled" });
}));

test("resolveRunState gives terminal STATE precedence over stale mailbox", () => {
  assert.equal(typeof runs.resolveRunState, "function");
  const resolved = runs.resolveRunState(
    { runId: "r1", status: "done" },
    { status: "question", question: "stale question" },
  );
  assert.equal(resolved.state.status, "done");
  assert.deepEqual(resolved.classified, { status: "done" });
  assert.equal(resolved.changed, false);
});

test("resolveRunState maps terminal mailbox and question onto stale active STATE", () => {
  const terminalCases = ["done", "failed", "cancelled"];
  for (const status of terminalCases) {
    const resolved = runs.resolveRunState(
      { runId: `r-${status}`, status: "watching" },
      { status, error: status === "failed" ? "boom" : undefined },
    );
    assert.equal(resolved.state.status, status);
    assert.equal(resolved.classified.status, status);
    assert.equal(resolved.changed, true);
  }

  const question = { status: "question", question: "Which database?", resultPath: "/tmp/RESULT.json" };
  const blocked = runs.resolveRunState({ runId: "r-question", status: "watching" }, question);
  assert.equal(blocked.state.status, "waiting_human");
  assert.deepEqual(blocked.classified, question);
  assert.equal(blocked.changed, true);
});

test("resolveRunState preserves capacity and decision states while mailbox watches", () => {
  for (const status of ["waiting_capacity", "waiting_decision"]) {
    const state = { runId: `r-${status}`, status, capacity: { auto_resume: false } };
    const resolved = runs.resolveRunState(state, { status: "watching" });
    assert.equal(resolved.state.status, status);
    assert.equal(resolved.changed, false);
  }
});

test("typed result matrix reconciles without weakening RESULT.json semantics", withTempRuns(async () => {
  const cases = [
    {
      name: "success",
      result: { schema: "team-up.result/v1", status: "success", summary: "ok" },
      classified: "done",
      state: "done",
    },
    {
      name: "partial",
      result: { schema: "team-up.result/v1", status: "partial", summary: "partial" },
      classified: "done",
      state: "done",
    },
    {
      name: "failed",
      result: { schema: "team-up.result/v1", status: "failed", summary: "bad" },
      classified: "failed",
      state: "failed",
    },
    {
      name: "blocked",
      result: {
        schema: "team-up.result/v1",
        status: "blocked",
        summary: "need input",
        questions: ["Choose a database"],
      },
      classified: "question",
      state: "waiting_human",
      question: /Choose a database/,
    },
    {
      name: "malformed",
      result: "{",
      classified: "failed",
      state: "failed",
    },
    {
      name: "unsupported schema",
      result: { schema: "team-up.result/v2", status: "success", summary: "future" },
      classified: "failed",
      state: "failed",
    },
    {
      name: "invalid status",
      result: { schema: "team-up.result/v1", status: "done-ish", summary: "bad" },
      classified: "failed",
      state: "failed",
    },
    {
      name: "missing result",
      result: undefined,
      classified: "failed",
      state: "failed",
    },
  ];

  for (const entry of cases) {
    const state = createFixture({ stateStatus: "watching", mailboxStatus: "done", typed: true });
    if (entry.result !== undefined) writeTyped(state.runId, entry.result);
    const classified = runs.classifyMailbox(state.runId);
    const resolved = runs.resolveRunState(state, classified);
    assert.equal(classified.status, entry.classified, entry.name);
    assert.equal(resolved.state.status, entry.state, entry.name);
    if (entry.question) assert.match(resolved.classified.question, entry.question);
    if (["done", "failed", "cancelled"].includes(entry.state)) {
      assert.deepEqual(
        runs.buildResumePlan(resolved.state, { tmuxExists: () => false }).actions,
        [],
        entry.name,
      );
    }
  }
}));

test("generic RESULT.md remains a valid terminal result", withTempRuns(async () => {
  const state = createFixture({ stateStatus: "watching", mailboxStatus: "done" });
  runs.atomicWriteText(path.join(runs.mailboxDir(state.runId), "RESULT.md"), "legacy result");
  const classified = runs.classifyMailbox(state.runId);
  const resolved = runs.resolveRunState(state, classified);
  assert.equal(classified.status, "done");
  assert.equal(resolved.state.status, "done");
}));

test("waitMailbox persists terminal reconciliation without rewriting mailbox", withTempRuns(async () => {
  const state = createFixture({ stateStatus: "watching", mailboxStatus: "done" });
  runs.atomicWriteText(path.join(runs.mailboxDir(state.runId), "RESULT.md"), "complete");

  const result = runs.waitMailbox(state.runId, { ceilingSec: 1 });

  assert.equal(result.classified.status, "done");
  assert.equal(runs.loadState(state.runId).status, "done");
  assert.equal(
    fs.readFileSync(path.join(runs.mailboxDir(state.runId), "STATUS"), "utf8").trim(),
    "done",
  );
}));

test("waitMailbox returns immediately from terminal STATE despite stale watching mailbox", withTempRuns(async () => {
  const state = createFixture({ stateStatus: "done", mailboxStatus: "watching" });

  const result = runs.waitMailbox(state.runId, { ceilingSec: 0 });

  assert.equal(result.waitExit, 0);
  assert.deepEqual(result.classified, { status: "done" });
  assert.equal(runs.loadState(state.runId).status, "done");
}));

test("waitMailbox persists waiting_human and preserves typed blocked questions", withTempRuns(async () => {
  const state = createFixture({
    stateStatus: "watching",
    mailboxStatus: "done",
    typed: true,
  });
  writeTyped(state.runId, {
    schema: "team-up.result/v1",
    status: "blocked",
    summary: "blocked",
    questions: ["Approve network access?"],
  });

  const result = runs.waitMailbox(state.runId, { ceilingSec: 1 });

  assert.equal(result.classified.status, "question");
  assert.match(result.classified.question, /Approve network access/);
  assert.equal(runs.loadState(state.runId).status, "waiting_human");
  assert.equal(
    fs.readFileSync(path.join(runs.mailboxDir(state.runId), "STATUS"), "utf8").trim(),
    "done",
  );
}));

test("resumeAll dry-run plans from terminal mailbox but leaves STATE untouched", withTempRuns(async (dir) => {
  const state = createFixture({ stateStatus: "watching", mailboxStatus: "done" });
  runs.atomicWriteText(path.join(runs.mailboxDir(state.runId), "RESULT.md"), "complete");
  const before = fs.readFileSync(path.join(runs.runDir(state.runId), "STATE.json"), "utf8");

  const report = runs.resumeAll({
    dryRun: true,
    tmuxExists: () => false,
    logDir: dir,
    now: new Date("2026-07-25T18:00:00Z"),
  });

  const run = report.runs.find((entry) => entry.runId === state.runId);
  assert.equal(run.status, "done");
  assert.deepEqual(run.actions, []);
  assert.equal(fs.readFileSync(path.join(runs.runDir(state.runId), "STATE.json"), "utf8"), before);
}));

test("resumeAll persists terminal mailbox and emits no worker, parent, or watcher action", withTempRuns(async (dir) => {
  for (const status of ["done", "failed", "cancelled"]) {
    const state = createFixture({ stateStatus: "watching", mailboxStatus: status, parentAttach: "tmux" });
    if (status !== "cancelled") {
      runs.atomicWriteText(path.join(runs.mailboxDir(state.runId), "RESULT.md"), `${status} result`);
    }
  }
  const executed = [];

  const report = runs.resumeAll({
    dryRun: false,
    tmuxExists: () => false,
    logDir: dir,
    now: new Date("2026-07-25T18:00:00Z"),
    execute: (action) => executed.push(action),
  });

  assert.equal(report.runs.length, 3);
  for (const entry of report.runs) {
    assert.ok(["done", "failed", "cancelled"].includes(entry.status));
    assert.deepEqual(entry.actions, []);
    assert.equal(runs.loadState(entry.runId).status, entry.status);
    assert.equal(
      fs.existsSync(path.join(runs.mailboxDir(entry.runId), "REATTACH_WATCHER")),
      false,
    );
  }
  assert.deepEqual(executed, []);
}));

test("resumeAll maps question to waiting_human before planning recovery", withTempRuns(async (dir) => {
  const state = createFixture({
    stateStatus: "watching",
    mailboxStatus: "waiting_human",
    parentAttach: "tmux",
  });
  runs.atomicWriteText(path.join(runs.mailboxDir(state.runId), "QUESTIONS.md"), "Which database?");

  const report = runs.resumeAll({
    dryRun: false,
    tmuxExists: () => false,
    logDir: dir,
    now: new Date("2026-07-25T18:00:00Z"),
    execute: () => {},
  });

  const entry = report.runs.find((item) => item.runId === state.runId);
  assert.equal(entry.status, "waiting_human");
  assert.equal(runs.loadState(state.runId).status, "waiting_human");
  assert.match(entry.actions.find((action) => action.kind === "spawn_parent").inject, /human question/);
  assert.match(runs.classifyMailbox(state.runId).question, /Which database/);
}));

test("capacity states never use generic recovery and due approved waits route supervision only", () => {
  const base = {
    runId: "capacity-run",
    cwd: "/tmp/project",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "dead-worker" },
  };
  const now = new Date("2026-07-25T18:30:00Z");
  const cases = [
    {
      name: "unapproved",
      state: {
        ...base,
        status: "waiting_capacity",
        capacity: { auto_resume: false, resume_not_before: "2026-07-25T18:00:00Z" },
      },
      actions: [],
    },
    {
      name: "future",
      state: {
        ...base,
        status: "waiting_capacity",
        capacity: { auto_resume: true, resume_not_before: "2026-07-25T19:00:00Z" },
      },
      actions: [],
    },
    {
      name: "cancelled wait",
      state: {
        ...base,
        status: "waiting_capacity",
        capacity: {
          auto_resume: false,
          wait_cancelled: true,
          resume_not_before: "2026-07-25T18:00:00Z",
        },
      },
      actions: [],
    },
    {
      name: "waiting decision",
      state: {
        ...base,
        status: "waiting_decision",
        capacity: { auto_resume: false, wait_cancelled: true },
      },
      actions: [],
    },
    {
      name: "due approved",
      state: {
        ...base,
        status: "waiting_capacity",
        capacity: { auto_resume: true, resume_not_before: "2026-07-25T18:00:00Z" },
      },
      actions: [{ kind: "resume_capacity_supervision", runId: "capacity-run" }],
    },
  ];

  for (const entry of cases) {
    const plan = runs.buildResumePlan(entry.state, { tmuxExists: () => false, now });
    assert.deepEqual(plan.actions, entry.actions, entry.name);
    assert.equal(plan.actions.some((action) => action.kind === "spawn_worker"), false, entry.name);
  }
});

test("resumeAll preserves waiting_capacity when mailbox says watching", withTempRuns(async (dir) => {
  const state = createFixture({ stateStatus: "waiting_capacity", mailboxStatus: "watching" });
  state.capacity = {
    auto_resume: true,
    wait_cancelled: false,
    resume_not_before: "2026-07-25T18:00:00Z",
  };
  runs.saveState(state);

  const report = runs.resumeAll({
    dryRun: true,
    tmuxExists: () => false,
    logDir: dir,
    now: new Date("2026-07-25T18:30:00Z"),
  });

  const entry = report.runs.find((item) => item.runId === state.runId);
  assert.equal(entry.status, "waiting_capacity");
  assert.deepEqual(entry.actions, [{ kind: "resume_capacity_supervision", runId: state.runId }]);
  assert.equal(runs.loadState(state.runId).status, "waiting_capacity");
}));
