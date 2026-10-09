import "../helpers/hermetic-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runsRoot, runDir, atomicWriteJson, atomicWriteText, createRun, loadState, saveState, updateState,
  classifyMailbox, writeAnswer, buildResumePlan, coldStartArgv, buildCliArgv,
  setStatus, resumeAll, linkDispatchToRun, listActiveStates,
  acquireResumeLock, resumeLockPath, waitTmuxReady,
  wrapPromptWithMailboxProtocol, promptHasMailboxProtocol, waitMailbox, resumeTmuxArgs,
  resolveGitBase, isValidRunId, listAllStates, executeResumeAction,
} from "../../src/runs/runs.mjs";
import { gcRuns } from "../../src/runs/gc.mjs";

const RUNS_BIN = fileURLToPath(new URL("../../src/runs/runs.mjs", import.meta.url));

function withTempRuns(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "o9k-runs-"));
    const prev = process.env.O9K_RUNS;
    process.env.O9K_RUNS = dir;
    try {
      await fn(dir);
    } finally {
      if (prev === undefined) delete process.env.O9K_RUNS;
      else process.env.O9K_RUNS = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("runsRoot respects O9K_RUNS", withTempRuns(async (dir) => {
  assert.equal(runsRoot(), dir);
}));

// An agent once passed the `mailbox: <path>` output line as a run id and got
// ~/.team-up/runs/'mailbox: '/home/... created by `runs answer`.
test("runDir refuses anything that is not a run id", withTempRuns(async () => {
  assert.equal(isValidRunId("20260922T100319Z-ri6m"), true);
  for (const bad of ["mailbox: /home/x/.team-up/runs/20260922T100319Z-ri6m/mailbox", "../evil", "r1", "", null]) {
    assert.equal(isValidRunId(bad), false, String(bad));
    assert.throws(() => runDir(bad), /invalid run id/);
  }
}));

test("createRun mints ids runDir accepts", withTempRuns(async () => {
  for (let i = 0; i < 20; i++) {
    const s = createRun({
      cwd: "/tmp/p", role: "implementer",
      parent: { cli: "claude", attach: "manual" },
      worker: { cli: "codex" },
      prompt: "x",
    });
    assert.equal(isValidRunId(s.runId), true, s.runId);
  }
}));

test("CLI answer with a bad run id fails and creates nothing", withTempRuns(async (dir) => {
  const r = spawnSync("node", [RUNS_BIN, "answer", "mailbox: /tmp/x/mailbox", "--text", "A"], {
    env: { ...process.env, O9K_RUNS: dir }, encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid run id/);
  assert.deepEqual(fs.readdirSync(dir), []);
}));

// The worker prompt offers `runs set-status <own id> done`. Writing STATE
// there decided the run before reconcile could apply the RESULT grace window
// or parent verification. A worker closing its own run now goes through the
// mailbox like the STATUS write the prompt names first; anyone else is
// unchanged, including a worker setting a child's status.
test("CLI set-status from a worker on its own run writes only the mailbox", withTempRuns(async (dir) => {
  const env = { ...process.env, O9K_RUNS: dir };
  delete env.TEAMUP_WORKER;
  delete env.TEAMUP_RUN_ID;
  const mk = () => createRun({
    cwd: "/tmp/proj", role: "implementer", parent: { cli: "manual", attach: "manual" },
    worker: { cli: "codex", model: "m" }, prompt: "x",
  });
  const setDone = (runId, as) =>
    spawnSync("node", [RUNS_BIN, "set-status", runId, "done"], { env: { ...env, ...as }, encoding: "utf8" });
  const seen = (runId) => [
    loadState(runId).status,
    fs.readFileSync(path.join(runDir(runId), "mailbox", "STATUS"), "utf8").trim(),
  ];

  const own = mk();
  assert.equal(setDone(own.runId, { TEAMUP_WORKER: "1", TEAMUP_RUN_ID: own.runId }).status, 0);
  assert.deepEqual(seen(own.runId), ["starting", "done"]);

  const child = mk();
  assert.equal(setDone(child.runId, { TEAMUP_WORKER: "1", TEAMUP_RUN_ID: own.runId }).status, 0);
  assert.deepEqual(seen(child.runId), ["done", "done"]);

  const human = mk();
  assert.equal(setDone(human.runId, {}).status, 0);
  assert.deepEqual(seen(human.runId), ["done", "done"]);
}));

// On the mailbox-only path a worker's --reason went nowhere: STATE.failure
// said "STATUS=failed" where it used to carry the worker's own words, and
// said nothing at all when gc adopted the failure.
test("a worker failing its own run keeps its --reason, whoever reconciles it", withTempRuns(async (dir) => {
  const fail = (runId) => spawnSync(
    "node",
    [RUNS_BIN, "set-status", runId, "failed", "--reason", "tests need DB creds"],
    { env: { ...process.env, O9K_RUNS: dir, TEAMUP_WORKER: "1", TEAMUP_RUN_ID: runId }, encoding: "utf8" },
  );
  const mk = () => {
    const { runId } = createRun({
      cwd: "/tmp/proj", role: "implementer", parent: { cli: "manual", attach: "manual" },
      worker: { cli: "codex", model: "m" }, prompt: "x",
    });
    setStatus(runId, "watching");
    assert.equal(fail(runId).status, 0);
    return runId;
  };

  const watched = mk();
  waitMailbox(watched, { ceilingSec: 1, observe: false, stopTmux: () => {} });
  assert.equal(loadState(watched).failure.error, "tests need DB creds");

  const unwatched = mk();
  gcRuns({
    states: [loadState(unwatched)],
    heartbeatFor: () => null,
    inspectTmux: () => ({ exists: false, activityMs: null, sessionId: null }),
    listSessions: () => [],
  });
  assert.equal(loadState(unwatched).status, "failed");
  assert.equal(loadState(unwatched).failure.error, "tests need DB creds");
}));

test("listAllStates passes over directories that are not runs", withTempRuns(async (dir) => {
  fs.mkdirSync(path.join(dir, "mailbox: "), { recursive: true });
  const corrupt = [];
  assert.deepEqual(listAllStates({ onCorrupt: (id) => corrupt.push(id) }), []);
  assert.deepEqual(corrupt, []);
}));

test("atomicWriteJson never leaves partial JSON", withTempRuns(async (dir) => {
  const target = path.join(dir, "x.json");
  atomicWriteJson(target, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { a: 1 });
  atomicWriteJson(target, { a: 2, b: "ok" });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { a: 2, b: "ok" });
}));

test("createRun writes STATE + mailbox skeleton", withTempRuns(async () => {
  const state = createRun({
    cwd: "/tmp/proj",
    project: "P0054",
    role: "implementer",
    parent: { cli: "claude", sessionId: "sess-1", attach: "manual" },
    worker: { cli: "codex", model: "gpt-test", tmux: "o9k-implementer-test" },
    prompt: "## Task\nDo the thing.\n",
  });
  assert.match(state.runId, /^\d{8}T\d{6}Z-[a-z0-9]+$/);
  assert.equal(state.status, "starting");
  assert.equal(state.parent.tmux, null);
  assert.equal(state.parent.attach, "manual");
  const rd = runDir(state.runId);
  assert.ok(fs.existsSync(path.join(rd, "STATE.json")));
  assert.ok(fs.existsSync(path.join(rd, "mailbox", "STATUS")));
  assert.equal(fs.readFileSync(path.join(rd, "mailbox", "STATUS"), "utf8").trim(), "starting");
  assert.match(fs.readFileSync(path.join(rd, "mailbox", "PROMPT.md"), "utf8"), /Do the thing/);
  assert.match(fs.readFileSync(path.join(rd, "mailbox", "PROMPT.md"), "utf8"), /HEARTBEAT/);
  assert.match(fs.readFileSync(path.join(rd, "mailbox", "PROMPT.md"), "utf8"), /STATUS.*done/i);
  assert.deepEqual(loadState(state.runId).runId, state.runId);
}));

test("saveState rejects a stale snapshot without clobbering newer fields", withTempRuns(async () => {
  const state = createRun({
    cwd: "/tmp/p",
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "original-worker" },
    prompt: "x",
  });
  const first = loadState(state.runId);
  const stale = loadState(state.runId);

  first.worker.tmux = "replacement-worker";
  saveState(first);
  stale.status = "done";

  assert.throws(
    () => saveState(stale),
    (error) => error?.code === "STATE_WRITE_CONFLICT",
  );
  const persisted = loadState(state.runId);
  assert.equal(persisted.worker.tmux, "replacement-worker");
  assert.equal(persisted.status, "starting");
}));

test("updateState applies a narrow mutation to the latest state", withTempRuns(async () => {
  const state = createRun({
    cwd: "/tmp/p",
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "original-worker" },
    prompt: "x",
  });
  const concurrent = loadState(state.runId);
  concurrent.worker.tmux = "replacement-worker";
  concurrent.supervision = { generation: 9 };
  saveState(concurrent);

  const updated = updateState(state.runId, (draft) => {
    draft.status = "done";
    return draft;
  });

  assert.equal(updated.status, "done");
  assert.equal(updated.worker.tmux, "replacement-worker");
  assert.deepEqual(updated.supervision, { generation: 9 });
  assert.deepEqual(loadState(state.runId), updated);
}));

test("classifyMailbox prefers question over watching", withTempRuns(async () => {
  const s = createRun({
    cwd: "/tmp/p", role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "t1" },
    prompt: "x",
  });
  const mb = path.join(runDir(s.runId), "mailbox");
  atomicWriteText(path.join(mb, "STATUS"), "waiting_human");
  atomicWriteText(path.join(mb, "QUESTIONS.md"), "Which DB?\n");
  const c = classifyMailbox(s.runId);
  assert.equal(c.status, "question");
  assert.match(c.question, /Which DB/);
}));

test("classifyMailbox returns done when RESULT present", withTempRuns(async () => {
  const s = createRun({
    cwd: "/tmp/p", role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "t1" },
    prompt: "x",
  });
  const mb = path.join(runDir(s.runId), "mailbox");
  atomicWriteText(path.join(mb, "STATUS"), "done");
  atomicWriteJson(path.join(mb, "RESULT.json"), {
    schema: "team-up.result/v1",
    status: "success",
    summary: "ok",
  });
  assert.equal(classifyMailbox(s.runId).status, "done");
}));

test("writeAnswer sets waiting path for worker", withTempRuns(async () => {
  const s = createRun({
    cwd: "/tmp/p", role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "t1" },
    prompt: "x",
  });
  writeAnswer(s.runId, "Use SQLite.", { source: "parent" });
  const ans = fs.readFileSync(path.join(runDir(s.runId), "mailbox", "ANSWER.md"), "utf8");
  assert.match(ans, /Use SQLite/);
  assert.equal(loadState(s.runId).status, "watching");
}));

test("classifyMailbox skips question when ANSWER is newer", withTempRuns(async () => {
  const s = createRun({
    cwd: "/tmp/p", role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "t1" },
    prompt: "x",
  });
  const mb = path.join(runDir(s.runId), "mailbox");
  atomicWriteText(path.join(mb, "QUESTIONS.md"), "Which DB?\n");
  // ensure ANSWER is strictly newer
  const t0 = Date.now();
  while (Date.now() <= t0) { /* spin */ }
  atomicWriteText(path.join(mb, "ANSWER.md"), "<!-- source: parent -->\nSQLite\n");
  atomicWriteText(path.join(mb, "STATUS"), "waiting_human");
  assert.equal(classifyMailbox(s.runId).status, "watching");
}));

test("CLI create prints runId", withTempRuns(async (dir) => {
  const pf = path.join(dir, "prompt.md");
  fs.writeFileSync(pf, "## Task\nHi\n");
  const out = execFileSync("node", [
    RUNS_BIN, "create",
    "--cwd", "/tmp/p",
    "--role", "implementer",
    "--parent-cli", "claude",
    "--parent-attach", "manual",
    "--worker-cli", "codex",
    "--worker-tmux", "o9k-w-1",
    "--prompt-file", pf,
  ], { env: { ...process.env, O9K_RUNS: dir }, encoding: "utf8" });
  assert.match(out, /runId:\s+\S+/);
  const id = out.match(/runId:\s+(\S+)/)[1];
  const c = execFileSync("node", [RUNS_BIN, "classify", id], {
    env: { ...process.env, O9K_RUNS: dir }, encoding: "utf8",
  });
  assert.match(c, /status:\s+watching/);
}));

test("CLI answer then classify watching", withTempRuns(async (dir) => {
  const pf = path.join(dir, "prompt.md");
  fs.writeFileSync(pf, "x\n");
  const out = execFileSync("node", [
    RUNS_BIN, "create", "--cwd", "/tmp/p", "--role", "implementer",
    "--parent-cli", "claude", "--parent-attach", "manual",
    "--worker-cli", "codex", "--worker-tmux", "t1", "--prompt-file", pf,
  ], { env: { ...process.env, O9K_RUNS: dir }, encoding: "utf8" });
  const id = out.match(/runId:\s+(\S+)/)[1];
  const mb = path.join(dir, id, "mailbox");
  fs.writeFileSync(path.join(mb, "QUESTIONS.md"), "Q?\n");
  fs.writeFileSync(path.join(mb, "STATUS"), "waiting_human\n");
  execFileSync("node", [RUNS_BIN, "answer", id, "--text", "A"], {
    env: { ...process.env, O9K_RUNS: dir }, encoding: "utf8",
  });
  const c = execFileSync("node", [RUNS_BIN, "classify", id], {
    env: { ...process.env, O9K_RUNS: dir }, encoding: "utf8",
  });
  assert.match(c, /status:\s+watching/);
}));

test("buildResumePlan skips terminal runs", () => {
  const plan = buildResumePlan({
    status: "done",
    runId: "20260101T000000Z-r001",
    cwd: "/tmp/p",
    parent: { attach: "manual" },
    worker: { cli: "codex", tmux: "w1" },
  });
  assert.deepEqual(plan.actions, []);
});

test("buildResumePlan restores worker tmux when missing", () => {
  const plan = buildResumePlan({
    status: "watching",
    runId: "20260101T000000Z-r001",
    cwd: "/tmp/p",
    parent: { attach: "manual", cli: "claude" },
    worker: { cli: "claude", sessionId: "abc", tmux: "w1" },
  }, { tmuxExists: () => false });
  assert.equal(plan.actions[0].kind, "spawn_worker");
  assert.equal(plan.actions[0].tmux, "w1");
  assert.match(plan.actions[0].inject, /Host crash recovery/);
});

test("buildResumePlan noops worker when tmux exists", () => {
  const plan = buildResumePlan({
    status: "watching",
    runId: "20260101T000000Z-r001",
    cwd: "/tmp/p",
    parent: { attach: "manual", cli: "claude" },
    worker: { cli: "codex", tmux: "w1" },
  }, { tmuxExists: (n) => n === "w1" });
  assert.ok(!plan.actions.some((a) => a.kind === "spawn_worker"));
  assert.ok(plan.actions.some((a) => a.kind === "flag_reattach_watcher"));
});

test("buildResumePlan leaves the parent to the grouped wake-up", () => {
  const plan = buildResumePlan({
    status: "waiting_human",
    runId: "20260101T000000Z-r001",
    cwd: "/tmp/p",
    parent: { attach: "tmux", cli: "claude", sessionId: "p1", tmux: "parent-1" },
    worker: { cli: "codex", tmux: "w1" },
  }, { tmuxExists: () => false });
  const kinds = plan.actions.map((a) => a.kind);
  assert.deepEqual(kinds, ["spawn_worker", "flag_reattach_watcher"]);
});

test("buildResumePlan never plans respawn for modern or legacy specialist runs", () => {
  const plan = buildResumePlan({
    status: "watching",
    runId: "20260101T000000Z-r001",
    role: "specialist:writer",
    specialist: { id: "writer", version: "1", checksum: "sha256:x" },
    cwd: "/tmp/p",
    parent: { attach: "manual", cli: "claude" },
    worker: { cli: "claude", sessionId: "abc", tmux: "w1" },
  }, { tmuxExists: () => false });
  assert.deepEqual(plan.actions.map((a) => a.kind), ["flag_reattach_watcher"]);

  const old = buildResumePlan({
    status: "watching",
    runId: "20260101T000000Z-r002",
    cwd: "/tmp/p",
    parent: { attach: "manual", cli: "claude" },
    worker: { cli: "claude", sessionId: "abc", tmux: "w2" },
    launch_descriptor: { path: "/x/launch.json" },
  }, { tmuxExists: () => false });
  assert.deepEqual(old.actions.map((a) => a.kind), ["flag_reattach_watcher"]);
});

test("buildCliArgv resumes a recorded session and has nothing for a cold start", () => {
  assert.deepEqual(buildCliArgv({ cli: "claude", sessionId: "abc" }), ["claude", "--resume", "abc"]);
  assert.deepEqual(buildCliArgv({ cli: "codex", sessionId: "abc" }), ["codex", "resume", "abc"]);
  assert.equal(buildCliArgv({ cli: "claude", sessionId: null }), null);
  assert.equal(buildCliArgv({ cli: "cursor", sessionId: "abc" }), null);
});

// The recovered worker's cwd is the task dir, not the run dir: a relative
// "mailbox/STATUS" points at nothing.
test("the recovery prompt names the mailbox by absolute path", withTempRuns(async () => {
  const s = createRun({
    cwd: "/tmp/p", role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "cursor", tmux: "w1" },
    prompt: "x",
  });
  setStatus(s.runId, "watching");
  const [spawnAction] = buildResumePlan(loadState(s.runId), { tmuxExists: () => false }).actions;
  const mb = path.join(runDir(s.runId), "mailbox");
  assert.match(spawnAction.inject, /Host crash recovery/);
  assert.ok(spawnAction.inject.includes(`${mb}/STATUS`), spawnAction.inject);
  assert.ok(spawnAction.inject.includes(`${mb}/PROMPT.md`), spawnAction.inject);
  assert.doesNotMatch(spawnAction.inject, /(^|\s)mailbox\//);
}));

const DISPATCH_ROSTER = {
  clis: {
    claude: { cmd: ["claude", "--dangerously-skip-permissions", "--model", "{model}", "--effort", "{effort}", "{prompt}"] },
    codex: { cmd: ["codex", "--dangerously-bypass-approvals-and-sandbox", "--model", "{model}", "{prompt}"] },
    cursor: { cmd: ["cursor-agent", "--yolo", "--trust", "--model", "{model}", "{prompt}"] },
  },
  models: {
    "claude-opus": { cli: ["claude"] },
    "gpt-x": { cli: ["codex"] },
    "grok-4.5": { cli: ["cursor"] },
  },
};

// Cold starts launched a bare `claude`/`codex` without --model or the
// permission flags, and `exec cursor` for the rest — the cursor shim exits 1
// unless its first argument is "agent". Both cold starts on record failed.
test("a cold start runs the command the dispatch used, with the recovery prompt", () => {
  const worker = (cli, model, effort = null) => ({ runId: "20260101T000000Z-r001", worker: { cli, model, effort } });
  assert.deepEqual(
    coldStartArgv(worker("claude", "claude-opus", "high"), DISPATCH_ROSTER, "RECOVER", "/tmp/task"),
    ["claude", "--dangerously-skip-permissions", "--model", "claude-opus", "--effort", "high", "RECOVER"],
  );
  assert.deepEqual(
    coldStartArgv(worker("cursor", "grok-4.5"), DISPATCH_ROSTER, "RECOVER", "/tmp/task"),
    ["cursor-agent", "--yolo", "--trust", "--model", "grok-4.5", "RECOVER"],
  );
  const codex = coldStartArgv(worker("codex", "gpt-x"), DISPATCH_ROSTER, "RECOVER", "/tmp/task");
  assert.equal(codex[0], "codex");
  assert.ok(codex.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(codex.some((a) => a.includes("trust_level")), "codex trusts the task dir as at dispatch");
  assert.equal(codex.at(-1), "RECOVER");
});

test("a cold start the roster cannot rebuild says why instead of launching something else", () => {
  const run = (cli, model) => ({ runId: "20260101T000000Z-r001", worker: { cli, model } });
  assert.throws(() => coldStartArgv(run("hermes", "m"), DISPATCH_ROSTER, "x", "/tmp"), /clis\.hermes\.cmd/);
  assert.throws(() => coldStartArgv(run("claude", null), DISPATCH_ROSTER, "x", "/tmp"), /worker\.model/);
  assert.throws(() => coldStartArgv(run("claude", "m"), null, "x", "/tmp"), /roster/);
});

test("resume refuses to respawn modern and legacy specialists, cold or by session", () => {
  const specialists = [
    {
      runId: "20260101T000000Z-r001",
      role: "specialist:writer",
      specialist: { id: "writer", version: "1", checksum: "sha256:x" },
      worker: { cli: "claude", model: "claude-opus" },
    },
    {
      runId: "20260101T000000Z-r002",
      worker: { cli: "claude", model: "claude-opus" },
      launch_descriptor: { path: "/x/launch.json" },
    },
  ];
  const action = (sessionId) => ({
    kind: "spawn_worker", tmux: "tu-test-refused-r001", cwd: "/tmp", cli: "claude", sessionId, inject: "x",
  });
  for (const specialist of specialists) {
    for (const sessionId of [null, "abc-session"]) {
      assert.throws(
        () => executeResumeAction(action(sessionId), specialist, { waitReady: () => true, readyTimeoutMs: 0 }),
        /specialist capsule/,
      );
    }
  }
});

test("waitTmuxReady returns true when pane non-empty", () => {
  let calls = 0;
  const ok = waitTmuxReady("sess", {
    timeoutMs: 1000,
    intervalMs: 10,
    capture: () => {
      calls++;
      return calls >= 2 ? "❯ ready\n" : "";
    },
    sleep: () => {},
  });
  assert.equal(ok, true);
  assert.ok(calls >= 2);
});

test("waitTmuxReady returns false on timeout", () => {
  const ok = waitTmuxReady("sess", {
    timeoutMs: 30,
    intervalMs: 10,
    capture: () => "",
    sleep: () => {},
  });
  assert.equal(ok, false);
});

test("listActiveStates skips corrupt STATE.json", withTempRuns(async (dir) => {
  const s = createRun({
    cwd: "/tmp/p", role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "t1" },
    prompt: "x",
  });
  setStatus(s.runId, "watching");
  const bad = path.join(dir, "20260101T000000Z-bad0");
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, "STATE.json"), "{not-json");
  const skipped = [];
  const active = listActiveStates({ onCorrupt: (id, e) => skipped.push(id) });
  assert.ok(active.some((r) => r.runId === s.runId));
  assert.ok(skipped.includes("20260101T000000Z-bad0"));
  // resumeAll must not throw
  const report = await resumeAll({ dryRun: true, tmuxExists: () => true, logDir: dir });
  assert.ok(report.runs.some((r) => r.runId === s.runId));
}));

test("resumeAll dry-run lists actions without tmux", withTempRuns(async (dir) => {
  const s = createRun({
    cwd: "/tmp/p", role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "claude", sessionId: "abc", tmux: "o9k-w-dry" },
    prompt: "x",
  });
  setStatus(s.runId, "watching");
  const report = await resumeAll({ dryRun: true, tmuxExists: () => false, logDir: dir });
  assert.ok(report.runs.some((r) => r.runId === s.runId));
  assert.ok(report.runs[0].actions.some((a) => a.kind === "spawn_worker"));
  assert.equal(report.logFile, null);
}));

test("resumeAll lock prevents concurrent run", withTempRuns(async (dir) => {
  const lock = path.join(dir, ".resume.lock");
  fs.writeFileSync(lock, String(process.pid));
  await assert.rejects(
    () => resumeAll({ dryRun: false, tmuxExists: () => true, logDir: dir, execute: () => {} }),
    /lock/,
  );
}));

test("resumeAll steals stale lock from dead pid", withTempRuns(async (dir) => {
  const lock = resumeLockPath();
  fs.writeFileSync(lock, "2147483646\n"); // almost certainly dead
  const report = await resumeAll({
    dryRun: false,
    tmuxExists: () => true,
    logDir: dir,
    execute: () => {},
  });
  assert.ok(report.logFile);
  assert.ok(!fs.existsSync(lock)); // released in finally
}));

test("acquireResumeLock steals then holds", withTempRuns(async (dir) => {
  const lock = path.join(dir, ".resume.lock");
  fs.writeFileSync(lock, "2147483646\n");
  acquireResumeLock(lock);
  assert.equal(fs.readFileSync(lock, "utf8").trim(), String(process.pid));
  assert.throws(() => acquireResumeLock(lock), /lock held/);
  fs.unlinkSync(lock);
}));

test("linkDispatchToRun sets worker.tmux and watching", withTempRuns(async () => {
  const s = createRun({
    cwd: "/tmp/p", role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", model: "old-model", tmux: null },
    prompt: "x",
  });
  assert.equal(linkDispatchToRun(s.runId, "o9k-sess-1", {
    cli: "cursor", model: "new-model", effort: "high",
  }), true);
  const st = loadState(s.runId);
  assert.equal(st.worker.tmux, "o9k-sess-1");
  assert.equal(st.worker.cli, "cursor");
  assert.equal(st.worker.model, "new-model");
  assert.equal(st.worker.effort, "high");
  assert.equal(st.status, "watching");
  assert.equal(st.watcher.attached, true);
}));

test("CLI wait ceiling returns exit 2", withTempRuns(async (dir) => {
  const pf = path.join(dir, "prompt.md");
  fs.writeFileSync(pf, "x\n");
  const out = execFileSync("node", [
    RUNS_BIN, "create", "--cwd", "/tmp/p", "--role", "implementer",
    "--parent-cli", "claude", "--parent-attach", "manual",
    "--worker-cli", "codex", "--worker-tmux", "t1", "--prompt-file", pf,
  ], { env: { ...process.env, O9K_RUNS: dir }, encoding: "utf8" });
  const id = out.match(/runId:\s+(\S+)/)[1];
  try {
    execFileSync("node", [RUNS_BIN, "wait", id, "--ceiling-sec", "2"], {
      env: { ...process.env, O9K_RUNS: dir }, encoding: "utf8",
    });
    assert.fail("expected non-zero exit");
  } catch (e) {
    assert.equal(e.status, 2);
  }
}));

test("wrapPromptWithMailboxProtocol wraps bare tasks", () => {
  const out = wrapPromptWithMailboxProtocol("Do the thing", {
    runId: "r1",
    runDirectory: "/tmp/runs/r1",
  });
  assert.match(out, /Do the thing/);
  assert.match(out, /HEARTBEAT/);
  assert.match(out, /STATUS.*done/i);
  assert.match(out, /r1/);
  assert.equal(promptHasMailboxProtocol(out), true);
  assert.equal(promptHasMailboxProtocol("Do the thing"), false);
});

test("wrapPromptWithMailboxProtocol is idempotent on already-wrapped prompts", () => {
  const once = wrapPromptWithMailboxProtocol("Task A", { runId: "r2", runDirectory: "/tmp/r2" });
  const twice = wrapPromptWithMailboxProtocol(once, { runId: "r2", runDirectory: "/tmp/r2" });
  assert.equal(twice, once.endsWith("\n") ? once : `${once}\n`);
});

test("waitMailbox stops worker tmux for every terminal outcome", withTempRuns(async () => {
  for (const status of ["done", "failed", "cancelled"]) {
    const state = createRun({
      cwd: "/tmp/p",
      role: "implementer",
      parent: { cli: "claude", attach: "manual" },
      worker: { cli: "codex", tmux: `worker-${status}` },
      prompt: "x",
    });
    setStatus(state.runId, "watching");
    if (status === "done") {
      atomicWriteText(path.join(runDir(state.runId), "mailbox", "RESULT.md"), "complete\n");
    }
    atomicWriteText(path.join(runDir(state.runId), "mailbox", "STATUS"), `${status}\n`);
    const stopped = [];

    const result = waitMailbox(state.runId, {
      ceilingSec: 1,
      stopTmux: session => {
        stopped.push(session);
        return true;
      },
    });

    assert.equal(result.classified.status, status);
    assert.deepEqual(stopped, [`worker-${status}`]);
  }
}));

test("waitMailbox stops worker tmux immediately for ordinary terminal outcomes", withTempRuns(async () => {
  const state = createRun({
    cwd: "/tmp/p",
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "worker-done" },
    prompt: "x",
  });
  setStatus(state.runId, "done");
  const stopped = [];

  waitMailbox(state.runId, {
    ceilingSec: 1,
    stopTmux: session => {
      stopped.push(session);
      return true;
    },
  });

  assert.deepEqual(stopped, ["worker-done"]);
}));

test("waitMailbox keeps worker tmux for a human question", withTempRuns(async () => {
  const state = createRun({
    cwd: "/tmp/p",
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "worker-question" },
    prompt: "x",
  });
  setStatus(state.runId, "waiting_human");
  atomicWriteText(path.join(runDir(state.runId), "mailbox", "QUESTIONS.md"), "Need input\n");
  const stopped = [];

  const result = waitMailbox(state.runId, {
    ceilingSec: 1,
    stopTmux: session => stopped.push(session),
  });

  assert.equal(result.classified.status, "question");
  assert.deepEqual(stopped, []);
}));

test("resolveGitBase returns nulls for non-git directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "o9k-nogit-"));
  const script = `import { resolveGitBase } from ${JSON.stringify(new URL("../../src/runs/runs.mjs", import.meta.url).href)}; console.log(JSON.stringify(resolveGitBase(process.argv[1])))`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, dir], { encoding: "utf8" });
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout), { base_commit: null, base_dirty: null });
  assert.equal(child.stderr, "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveGitBase records clean commit in temp git repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "o9k-git-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README"), "hi\n");
  execFileSync("git", ["add", "README"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const base = resolveGitBase(dir);
  assert.equal(base.base_commit, head);
  assert.equal(base.base_dirty, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveGitBase records dirty working tree", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "o9k-git-dirty-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README"), "hi\n");
  execFileSync("git", ["add", "README"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "dirty.txt"), "change\n");
  const base = resolveGitBase(dir);
  assert.equal(base.base_dirty, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createRun stores base_commit and base_dirty", withTempRuns(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "o9k-create-git-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README"), "hi\n");
  execFileSync("git", ["add", "README"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

  const state = createRun({
    cwd: dir,
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "t1" },
    prompt: "x",
  });
  assert.equal(state.base_commit, head);
  assert.equal(state.base_dirty, false);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test("resumeTmuxArgs marks a respawned worker with run id, never the parent", () => {
  const state = { runId: "r42" };
  const worker = resumeTmuxArgs(
    { kind: "spawn_worker", tmux: "w", cwd: "/tmp/task" }, state, ["claude", "--resume", "s1"],
  );
  assert.deepEqual(worker, [
    "new-session", "-d", "-s", "w", "-c", "/tmp/task",
    "-e", "TEAMUP_WORKER=1", "-e", "TEAMUP_RUN_ID=r42",
    "claude --resume s1",
  ]);

  const parent = resumeTmuxArgs({ kind: "spawn_parent", tmux: "p", cwd: "/tmp/task" }, state, ["claude"]);
  assert.deepEqual(parent, ["new-session", "-d", "-s", "p", "-c", "/tmp/task", "claude"]);
});
