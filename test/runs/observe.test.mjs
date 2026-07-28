import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as runs from "../../src/runs/runs.mjs";
import {
  normalizePaneText,
  paneFingerprint,
  matchesDenyPattern,
  verifyVerdict,
  parseJudgeJson,
  observerTick,
  createObserverLoop,
  handleStall,
  handlePostAnswerStall,
  handleSilenceEscalate,
  appendObservationLog,
  observationLogPath,
  escalateRun,
  hydrateLoopFromLog,
  getMailboxAge,
  tryAcquireObserverLock,
  releaseObserverLock,
  isProcessAlive,
  resolveObserverJudge,
  buildJudgeArgv,
  buildJudgePrompt,
  tailPane,
  validateVerdictShape,
  sendTmuxKeys,
  defaultCapture,
  runObserver,
  MAX_AUTO_ANSWERS,
  MAX_KEYS_PER_ANSWER,
  MAX_SILENCE_JUDGE_CALLS,
  ALLOWED_KEYS,
  DEFAULT_SILENCE_SEC,
  DEFAULT_STALL_TICKS,
  PANE_TAIL_BYTES,
  OBSERVER_PID_FILE,
  OBSERVATION_LOG_FILE,
} from "../../src/runs/observe.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/panes");

function readFixture(rel) {
  return fs.readFileSync(path.join(FIXTURES, rel), "utf8");
}

function withTempRuns(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-observe-"));
    const prev = process.env.TEAM_UP_RUNS;
    delete process.env.O9K_RUNS;
    process.env.TEAM_UP_RUNS = dir;
    try {
      await fn(dir);
    } finally {
      if (prev === undefined) delete process.env.TEAM_UP_RUNS;
      else process.env.TEAM_UP_RUNS = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function createRunWithTmux() {
  const state = runs.createRun({
    cwd: "/tmp/project",
    role: "implementer",
    parent: { cli: "cursor", attach: "manual" },
    worker: { cli: "cursor-agent", tmux: "test-worker-session" },
    prompt: "do work",
  });
  runs.setStatus(state.runId, "watching");
  return runs.loadState(state.runId);
}

function touchMailbox(runId, name = "HEARTBEAT", content = new Date().toISOString()) {
  const p = path.join(runs.mailboxDir(runId), name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const TEST_ROSTER = {
  clis: {
    cursor: { cmd: ["cursor-agent", "--yolo", "--model", "{model}", "{prompt}"] },
    codex: { cmd: ["codex", "--model", "{model}", "{prompt}"] },
    claude: { cmd: ["claude", "--model", "{model}", "{prompt}"] },
  },
  models: {
    "grok-4.5-high": { provider: "xai", cli: ["cursor"] },
    "gpt-5.4-mini": { provider: "openai", cli: ["codex"] },
    "claude-opus": { provider: "anthropic", cli: ["claude"] },
  },
  roles: {
    observer: { chain: ["cursor:grok-4.5-high", "codex:gpt-5.4-mini"] },
  },
};

const CLAUDE_ONLY_ROSTER = {
  ...TEST_ROSTER,
  roles: { observer: { chain: ["claude:claude-opus"] } },
};

test("normalizePaneText trims trailing whitespace per line only", () => {
  const raw = "hello   \n  world \n";
  assert.equal(normalizePaneText(raw), "hello\n  world\n");
});

test("tailPane returns tail bounded by maxBytes", () => {
  const big = "a".repeat(PANE_TAIL_BYTES + 100);
  const tailed = tailPane(big);
  assert.equal(Buffer.byteLength(tailed, "utf8"), PANE_TAIL_BYTES);
  assert.ok(tailed.endsWith("a".repeat(100)));
});

test("validateVerdictShape rejects bad shapes", () => {
  assert.equal(validateVerdictShape(null).ok, false);
  assert.equal(validateVerdictShape({ state: "nope", action: "wait" }).ok, false);
  assert.equal(validateVerdictShape({ state: "working", action: "answer" }).ok, false);
  assert.equal(validateVerdictShape({ state: "working", action: "wait" }).ok, true);
});

test("resolveObserverJudge rejects claude", () => {
  const r = resolveObserverJudge(CLAUDE_ONLY_ROSTER, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /must not be claude/);
});

test("buildJudgeArgv throws for claude cli", () => {
  assert.throws(
    () => buildJudgeArgv({
      roster: TEST_ROSTER,
      cli: "claude",
      model: "claude-opus",
      prompt: "x",
    }),
    /must not use claude/,
  );
});

test("buildJudgePrompt includes mailbox age and frozen-screen guidance", () => {
  const prompt = buildJudgePrompt({
    pane: "frozen",
    cli: "hermes",
    runId: "r1",
    role: "worker",
    elapsedSec: 90,
    mailboxAgeSec: 30,
    silenceSec: 120,
  });
  assert.match(prompt, /mailbox_age_sec: 30/);
  assert.match(prompt, /silence_sec: 120/);
  assert.match(prompt, /frozen terminal screen is NOT evidence of idleness/i);
});

test("working cursor-agent panes differ across ticks and never reach stall", () => {
  const panes = [
    readFixture("cursor-agent/working-10s.txt"),
    readFixture("cursor-agent/working-30s.txt"),
    readFixture("cursor-agent/working-60s.txt"),
  ];
  const loop = createObserverLoop();
  let judgeCalls = 0;
  for (const pane of panes) {
    const next = observerTick(loop, pane, { mailboxAgeSec: 0 });
    Object.assign(loop, next);
    if (next.event === "stall_detected") judgeCalls++;
  }
  assert.equal(judgeCalls, 0);
});

test("frozen startup-idle pane trips stall after exactly 3 identical captures", () => {
  const frozen = readFixture("cursor-agent/startup-idle-3s.txt");
  const loop = createObserverLoop();
  const events = [];
  for (let i = 0; i < 7; i++) {
    const next = observerTick(loop, frozen, { mailboxAgeSec: 0 });
    Object.assign(loop, next);
    events.push(next.event);
  }
  assert.deepEqual(events.filter((e) => e === "stall_detected"), ["stall_detected"]);
  assert.deepEqual(events.slice(4), ["stall_ongoing", "stall_ongoing", "stall_ongoing"]);
});

test("hermes ticking footer never pane-stalls but silence trigger fires", () => {
  const panes = [
    readFixture("hermes/trust-prompt-6s.txt"),
    readFixture("hermes/trust-prompt-10s.txt"),
    readFixture("hermes/trust-prompt-6s.txt"),
    readFixture("hermes/trust-prompt-10s.txt"),
  ];
  const loop = createObserverLoop();
  const freshEvents = [];
  for (const pane of panes) {
    const next = observerTick(loop, pane, { mailboxAgeSec: 5 });
    Object.assign(loop, next);
    freshEvents.push(next.event);
  }
  assert.equal(freshEvents.filter((e) => e === "stall_detected").length, 0);

  const silentLoop = createObserverLoop();
  const silent = observerTick(silentLoop, panes[0], {
    mailboxAgeSec: DEFAULT_SILENCE_SEC,
    silenceSec: DEFAULT_SILENCE_SEC,
  });
  assert.equal(silent.event, "stall_detected");
  assert.equal(silent.trigger, "silence");
});

test("frozen pane with fresh mailbox re-opens episode when mailbox goes stale", () => {
  const frozen = readFixture("cursor-agent/trust-prompt-6s.txt");
  const loop = createObserverLoop();
  const silenceSec = 120;

  // Episode 1: pane stalled, mailbox fresh -> judge once, then stall_ongoing
  for (let i = 0; i < 3; i++) {
    const next = observerTick(loop, frozen, { mailboxAgeSec: 5, silenceSec });
    Object.assign(loop, next);
  }
  assert.equal(loop.judgeCalledThisEpisode, false);
  const ep1 = observerTick(loop, frozen, { mailboxAgeSec: 5, silenceSec });
  Object.assign(loop, ep1);
  assert.equal(ep1.event, "stall_detected");

  loop.judgeCalledThisEpisode = true; // simulate handleStall wait downgrade

  const ongoing = observerTick(loop, frozen, { mailboxAgeSec: 5, silenceSec });
  Object.assign(loop, ongoing);
  assert.equal(ongoing.event, "stall_ongoing");

  // Episode 2: same frozen pane, mailbox now stale -> latch clears, judge again
  const ep2 = observerTick(loop, frozen, { mailboxAgeSec: silenceSec, silenceSec });
  Object.assign(loop, ep2);
  assert.equal(ep2.event, "stall_detected");
  assert.equal(ep2.trigger, "both");
});

test("trust-prompt verdict with allowlisted keys is honoured when mailbox stale", () => {
  const pane = readFixture("cursor-agent/trust-prompt-6s.txt");
  const verdict = {
    state: "waiting_input",
    reason: "trust dialog",
    action: "answer",
    keys: ["Enter"],
    evidence: "Trust this workspace",
  };
  const result = verifyVerdict(verdict, pane, {
    ...createObserverLoop(),
    mailboxAgeSec: DEFAULT_SILENCE_SEC,
    silenceSec: DEFAULT_SILENCE_SEC,
  });
  assert.equal(result.action, "answer");
});

test("deny pattern in help text does not escalate a wait verdict", () => {
  const pane = "opencode stats               show token usage and cost statistics\n> working...";
  const result = verifyVerdict(
    { state: "working", action: "wait", reason: "still working" },
    pane,
    { autoAnswerCount: 0, answeredPanes: new Set(), mailboxAgeSec: 1, silenceSec: 120 },
  );
  assert.equal(result.action, "wait");
});

test("verdict with too many keys is downgraded to escalate", () => {
  const keys = Array(MAX_KEYS_PER_ANSWER + 1).fill("Enter");
  const result = verifyVerdict(
    { state: "waiting_input", reason: "spam", action: "answer", keys },
    "plain pane",
    { autoAnswerCount: 0, answeredPanes: new Set(), mailboxAgeSec: 999, silenceSec: 120 },
  );
  assert.equal(result.action, "escalate");
  assert.match(result.reason, /too many keys/);
});

test("verdict with free-text keys is downgraded to escalate", () => {
  const pane = readFixture("opencode/trust-prompt-6s.txt");
  const verdict = {
    state: "waiting_input",
    reason: "trust",
    action: "answer",
    keys: ["yes trust this folder"],
    evidence: "trust",
  };
  const result = verifyVerdict(verdict, pane, createObserverLoop());
  assert.equal(result.action, "escalate");
  assert.match(result.reason, /disallowed key/);
});

test("login_required always escalates even without deny pattern in pane", () => {
  const pane = "Welcome! Choose an account to continue.";
  const verdict = {
    state: "login_required",
    reason: "auth screen",
    action: "answer",
    keys: ["Enter"],
    evidence: "account picker",
  };
  const result = verifyVerdict(verdict, pane, createObserverLoop());
  assert.equal(result.action, "escalate");
  assert.match(result.reason, /login_required/);
  assert.ok(!matchesDenyPattern(pane));
});

test("credential pane escalates via deny pattern only on answer proposals", () => {
  const pane = "Please enter your API key to continue\n> ";
  const answerVerdict = {
    state: "waiting_input",
    reason: "needs key",
    action: "answer",
    keys: ["Enter"],
    evidence: "API key",
  };
  const answerResult = verifyVerdict(answerVerdict, pane, createObserverLoop());
  assert.equal(answerResult.action, "escalate");
  assert.match(answerResult.reason, /deny pattern/);

  const waitVerdict = {
    state: "working",
    reason: "still working",
    action: "wait",
    evidence: "API key prompt visible but worker active",
  };
  const waitResult = verifyVerdict(waitVerdict, pane, createObserverLoop());
  assert.equal(waitResult.action, "wait");
});

test("dangerous keys are not on the allowlist", () => {
  const dangerous = [
    "rm", "sudo", "delete", "quit", "C-c", ":", "!", "a", "A", "Enter\nrm -rf",
    "yes trust this folder", "Backspace", "Home", "End",
  ];
  for (const key of dangerous) {
    assert.ok(!ALLOWED_KEYS.has(key), `dangerous key must not be allowed: ${key}`);
  }
});

test("judge timeout escalates once", withTempRuns(async () => {
  const state = createRunWithTmux();
  const loop = createObserverLoop();
  const logs = [];
  const judge = () => ({ ok: false, error: "timeout" });

  const r1 = handleStall({
    runId: state.runId,
    state,
    loop,
    capture: readFixture("cursor-agent/startup-idle-5s.txt"),
    deps: {
      roster: TEST_ROSTER,
      usage: {},
      judge,
      log: (e) => logs.push(e),
      now: () => Date.now(),
      mailboxAgeSec: DEFAULT_SILENCE_SEC,
    },
  });
  assert.equal(r1.stop, true);
  assert.equal(runs.loadState(state.runId).status, "waiting_human");

  const r2 = handleStall({
    runId: state.runId,
    state,
    loop: r1.loop,
    capture: readFixture("cursor-agent/startup-idle-5s.txt"),
    deps: {
      roster: TEST_ROSTER,
      usage: {},
      judge,
      log: (e) => logs.push(e),
      now: () => Date.now(),
      mailboxAgeSec: DEFAULT_SILENCE_SEC,
    },
  });
  assert.equal(r2.stop, false);
  assert.equal(logs.filter((l) => l.kind === "decision" && l.action === "escalate").length, 1);
}));

test("handleStall sends keys and logs answer with pane fingerprint", withTempRuns(async () => {
  const state = createRunWithTmux();
  const loop = createObserverLoop();
  const sent = [];
  const logs = [];
  const pane = readFixture("cursor-agent/trust-prompt-6s.txt");
  const verdict = {
    state: "waiting_input",
    reason: "trust dialog",
    action: "answer",
    keys: ["Enter"],
    evidence: "Trust",
  };
  const result = handleStall({
    runId: state.runId,
    state,
    loop,
    capture: pane,
    deps: {
      roster: TEST_ROSTER,
      usage: {},
      judge: () => ({ ok: true, stdout: JSON.stringify(verdict) }),
      sendKeys: (keys) => sent.push(...keys),
      log: (e) => logs.push(e),
      now: () => Date.now(),
      mailboxAgeSec: DEFAULT_SILENCE_SEC,
    },
  });
  assert.equal(result.stop, false);
  assert.deepEqual(sent, ["Enter"]);
  assert.equal(result.loop.autoAnswerCount, 1);
  assert.ok(result.loop.awaitingPostAnswer);
  const actionLog = logs.find((l) => l.kind === "action");
  assert.equal(actionLog.pane_fp, paneFingerprint(pane));
}));

test("post-answer stall escalates after stallTicks identical captures", withTempRuns(async () => {
  const state = createRunWithTmux();
  const loop = createObserverLoop();
  const frozen = readFixture("cursor-agent/startup-idle-3s.txt");
  loop.prevFingerprint = paneFingerprint(frozen);
  loop.awaitingPostAnswer = true;
  for (let i = 0; i < DEFAULT_STALL_TICKS - 1; i++) {
    const next = observerTick(loop, frozen);
    Object.assign(loop, next);
    assert.notEqual(next.event, "post_answer_stall");
  }
  const final = observerTick(loop, frozen);
  assert.equal(final.event, "post_answer_stall");
  const result = handlePostAnswerStall({ runId: state.runId, loop, deps: {} });
  assert.equal(result.stop, true);
  assert.equal(runs.loadState(state.runId).status, "waiting_human");
}));

test("hydrateLoopFromLog restores caps across re-wait", withTempRuns(async () => {
  const state = createRunWithTmux();
  const pane = readFixture("cursor-agent/trust-prompt-6s.txt");
  const fp = paneFingerprint(pane);
  appendObservationLog(state.runId, {
    kind: "action",
    action: "answer",
    keys: ["Enter"],
    auto_answer_count: 2,
    pane_fp: fp,
  });
  const loop = hydrateLoopFromLog(state.runId);
  assert.equal(loop.autoAnswerCount, 1);
  assert.ok(loop.answeredPanes.has(fp));
}));

test("escalateRun appends QUESTIONS.md instead of clobbering", withTempRuns(async () => {
  const state = createRunWithTmux();
  const mb = runs.mailboxDir(state.runId);
  fs.writeFileSync(path.join(mb, "QUESTIONS.md"), "<!-- source: worker -->\n\nReal worker question\n");
  escalateRun(state.runId, "Observer escalation");
  const body = fs.readFileSync(path.join(mb, "QUESTIONS.md"), "utf8");
  assert.match(body, /Real worker question/);
  assert.match(body, /Observer escalation/);
  assert.match(body, /---/);
}));

test("getMailboxAge ignores observer-owned files and clamps negative", withTempRuns(async () => {
  const state = createRunWithTmux();
  const mb = runs.mailboxDir(state.runId);
  touchMailbox(state.runId, "HEARTBEAT", "fresh");
  const heartbeatPath = path.join(mb, "HEARTBEAT");
  const fileMtimeMs = fs.statSync(heartbeatPath).mtimeMs;
  const nowMs = fileMtimeMs + 45_000;
  const age = getMailboxAge(state.runId, { now: () => nowMs });
  assert.equal(age, 45);

  fs.writeFileSync(path.join(mb, OBSERVER_PID_FILE), `${process.pid}\n`);
  fs.writeFileSync(path.join(mb, OBSERVATION_LOG_FILE), '{"kind":"decision"}\n');
  const ageAfterObserver = getMailboxAge(state.runId, { now: () => nowMs });
  assert.equal(ageAfterObserver, 45);

  const futureNow = fileMtimeMs - 500;
  assert.equal(getMailboxAge(state.runId, { now: () => futureNow }), 0);
}));

test("getMailboxAge reflects newest worker file mtime", withTempRuns(async () => {
  const state = createRunWithTmux();
  touchMailbox(state.runId, "HEARTBEAT", "fresh");
  const heartbeatPath = path.join(runs.mailboxDir(state.runId), "HEARTBEAT");
  const fileMtimeMs = fs.statSync(heartbeatPath).mtimeMs;
  const nowMs = fileMtimeMs + 45_000;
  const age = getMailboxAge(state.runId, { now: () => nowMs });
  assert.equal(age, 45);
}));

test("stale observer pid lock is replaced on takeover", withTempRuns(async () => {
  const state = createRunWithTmux();
  const lockPath = path.join(runs.mailboxDir(state.runId), OBSERVER_PID_FILE);
  fs.writeFileSync(lockPath, "999999\n");
  const takeover = tryAcquireObserverLock(state.runId, { pid: process.pid });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.replacedStale, true);
  assert.equal(fs.readFileSync(lockPath, "utf8").trim(), String(process.pid));
  releaseObserverLock(state.runId);
}));

test("second observer exits when lock held by live pid", withTempRuns(async () => {
  const state = createRunWithTmux();
  const first = tryAcquireObserverLock(state.runId, { pid: process.pid });
  assert.equal(first.ok, true);
  const second = tryAcquireObserverLock(state.runId, { pid: process.pid + 100_000 });
  assert.equal(second.ok, false);
  releaseObserverLock(state.runId);
}));

test("runObserver exits when parent dies", withTempRuns(async () => {
  const state = createRunWithTmux();
  touchMailbox(state.runId);
  let iterations = 0;
  await runObserver(state.runId, {
    pollSec: 0.001,
    sleep: async () => { iterations += 1; },
    capture: () => readFixture("cursor-agent/startup-idle-3s.txt"),
    parentPid: 1,
    isParentAlive: () => iterations < 1,
    acquireLock: () => ({ ok: true }),
    keepLock: true,
    roster: TEST_ROSTER,
    usage: {},
  });
  assert.equal(iterations, 1);
}));

test("runObserver second instance acquireLock failure exits immediately", withTempRuns(async () => {
  const state = createRunWithTmux();
  const failures = [];
  await runObserver(state.runId, {
    acquireLock: () => ({ ok: false, reason: "another observer is running" }),
    logLockFailure: (msg) => failures.push(msg),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /lock not acquired/);
}));

test("hydrateLoopFromLog counts answers and treats malformed line as answer", withTempRuns(async () => {
  const state = createRunWithTmux();
  const p = observationLogPath(state.runId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const good = JSON.stringify({ kind: "action", action: "answer", pane_fp: "A" });
  const good2 = JSON.stringify({ kind: "action", action: "answer", pane_fp: "B" });
  const good3 = JSON.stringify({ kind: "action", action: "answer", pane_fp: "C" });
  fs.writeFileSync(p, `${good}\n${good2}\n${good3.slice(0, 40)}`);
  const loop = hydrateLoopFromLog(state.runId);
  assert.equal(loop.autoAnswerCount, 3);
  assert.equal(loop.answeredPanes.size, 2);
  const v = verifyVerdict(
    { state: "waiting_input", action: "answer", keys: ["Enter"] },
    "some pane",
    { ...loop, mailboxAgeSec: 999, silenceSec: 120 },
  );
  assert.equal(v.action, "escalate");
  assert.match(v.reason, /auto-answer cap/);
}));

test("silence path allows two judge calls then escalates unconditionally", () => {
  const pane = readFixture("hermes/trust-prompt-6s.txt");
  const loop = createObserverLoop();
  const silenceSec = 10;
  const t0 = 1_000_000;
  loop.silenceJudgeCount = MAX_SILENCE_JUDGE_CALLS;
  loop.judgeCalledThisEpisode = true;

  const third = observerTick(loop, `${pane}\nmore`, {
    mailboxAgeSec: silenceSec,
    silenceSec,
    now: () => t0 + 30_000,
  });
  assert.equal(third.event, "silence_escalate");
});

test("silence judge calls respect minimum interval", () => {
  const pane = readFixture("hermes/trust-prompt-6s.txt");
  const loop = createObserverLoop();
  const silenceSec = 10;
  const t0 = 1_000_000;

  const first = observerTick(loop, `${pane}\na`, {
    mailboxAgeSec: silenceSec,
    silenceSec,
    now: () => t0,
  });
  Object.assign(loop, first);
  loop.silenceJudgeCount = 1;
  loop.lastSilenceJudgeAt = t0;
  loop.judgeCalledThisEpisode = true;

  const tooSoon = observerTick(loop, `${pane}\nb`, {
    mailboxAgeSec: silenceSec,
    silenceSec,
    now: () => t0 + 5000,
  });
  assert.equal(tooSoon.event, "stall_ongoing");

  loop.judgeCalledThisEpisode = true;
  const ready = observerTick(loop, `${pane}\nc`, {
    mailboxAgeSec: silenceSec,
    silenceSec,
    now: () => t0 + 11_000,
  });
  assert.equal(ready.event, "stall_detected");
});

test("post-answer escalation via real auto-answer path", withTempRuns(async () => {
  const state = createRunWithTmux();
  const pane = readFixture("cursor-agent/trust-prompt-6s.txt");
  let loop = createObserverLoop();
  const sent = [];
  const stall = handleStall({
    runId: state.runId,
    state,
    loop,
    capture: pane,
    deps: {
      roster: TEST_ROSTER,
      usage: {},
      judge: () => ({
        ok: true,
        stdout: JSON.stringify({
          state: "waiting_input",
          reason: "trust",
          action: "answer",
          keys: ["Enter"],
        }),
      }),
      sendKeys: (keys) => sent.push(...keys),
      now: () => Date.now(),
      mailboxAgeSec: DEFAULT_SILENCE_SEC,
    },
  });
  loop = stall.loop;
  assert.deepEqual(sent, ["Enter"]);
  assert.ok(loop.awaitingPostAnswer);

  for (let i = 0; i < DEFAULT_STALL_TICKS - 1; i++) {
    const next = observerTick(loop, pane);
    Object.assign(loop, next);
    assert.notEqual(next.event, "post_answer_stall");
  }
  const final = observerTick(loop, pane);
  assert.equal(final.event, "post_answer_stall");
  const result = handlePostAnswerStall({ runId: state.runId, loop, deps: {} });
  assert.equal(result.stop, true);
  assert.equal(runs.loadState(state.runId).status, "waiting_human");
}));

test("handleSilenceEscalate sets waiting_human", withTempRuns(async () => {
  const state = createRunWithTmux();
  const loop = createObserverLoop();
  const result = handleSilenceEscalate({ runId: state.runId, loop, deps: {} });
  assert.equal(result.stop, true);
  assert.equal(runs.loadState(state.runId).status, "waiting_human");
}));

test("parseJudgeJson unwraps cursor-agent result envelope", () => {
  const envelope = JSON.stringify({
    type: "result",
    subtype: "success",
    result: '{"state":"waiting_input","reason":"trust","action":"answer","keys":["Enter"],"evidence":"trust"}',
  });
  const r = parseJudgeJson(envelope);
  assert.equal(r.ok, true);
  assert.equal(r.verdict.action, "answer");
});

test("auto-answer cap enforced", () => {
  const loop = createObserverLoop();
  loop.autoAnswerCount = MAX_AUTO_ANSWERS;
  const verdict = {
    state: "waiting_input",
    reason: "prompt",
    action: "answer",
    keys: ["Enter"],
    evidence: "ok",
  };
  const result = verifyVerdict(verdict, "same pane", {
    ...loop,
    mailboxAgeSec: DEFAULT_SILENCE_SEC,
    silenceSec: DEFAULT_SILENCE_SEC,
  });
  assert.equal(result.action, "escalate");
});

test("repeat-pane guard blocks second answer on same pane", () => {
  const pane = readFixture("opencode/trust-prompt-6s.txt");
  const loop = createObserverLoop();
  loop.answeredPanes.add(paneFingerprint(pane));
  const verdict = {
    state: "waiting_input",
    reason: "trust",
    action: "answer",
    keys: ["Enter"],
    evidence: "trust",
  };
  const result = verifyVerdict(verdict, pane, {
    ...loop,
    mailboxAgeSec: DEFAULT_SILENCE_SEC,
    silenceSec: DEFAULT_SILENCE_SEC,
  });
  assert.equal(result.action, "escalate");
});

test("working panes across CLIs with ticking footers do not pane-stall", () => {
  const workingMeta = [
    "cursor-agent/working.meta.json",
    "codex/working.meta.json",
    "claude/working.meta.json",
    "hermes/working.meta.json",
    "opencode/working.meta.json",
  ];
  for (const metaPath of workingMeta) {
    const meta = JSON.parse(readFixture(metaPath));
    const loop = createObserverLoop();
    let stalls = 0;
    for (const cap of meta.captures) {
      const pane = readFixture(cap.file);
      const next = observerTick(loop, pane, { mailboxAgeSec: 0 });
      Object.assign(loop, next);
      if (next.event === "stall_detected" && next.trigger !== "silence") stalls++;
    }
    assert.equal(stalls, 0, `${meta.cli} working fixtures should not pane-stall`);
  }
});

test("sendTmuxKeys invokes tmux send-keys per key", () => {
  const calls = [];
  sendTmuxKeys("sess", ["Enter", "y"], {
    execFile: (cmd, args) => calls.push([cmd, ...args]),
  });
  assert.deepEqual(calls, [
    ["tmux", "send-keys", "-t", "sess", "Enter"],
    ["tmux", "send-keys", "-t", "sess", "y"],
  ]);
});

test("defaultCapture returns empty string when tmux fails", () => {
  const out = defaultCapture("missing-session", {
    execFile: () => {
      throw new Error("no session");
    },
  });
  assert.equal(out, "");
});

test("isProcessAlive returns true for current pid", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
});

test("waitMailbox spawns and kills observer child", withTempRuns(async () => {
  const state = createRunWithTmux();
  runs.atomicWriteText(path.join(runs.mailboxDir(state.runId), "STATUS"), "watching");

  let spawned = false;
  let killed = false;
  const fakeChild = {
    exitCode: null,
    kill(sig) {
      killed = true;
      this.exitCode = 0;
      assert.equal(sig, "SIGTERM");
    },
  };

  const result = runs.waitMailbox(state.runId, {
    ceilingSec: 0,
    spawnObserver: () => {
      spawned = true;
      return fakeChild;
    },
  });
  assert.ok(spawned);
  assert.ok(killed);
  assert.equal(result.waitExit, 2);
}));
