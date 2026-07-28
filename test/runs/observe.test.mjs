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
  ALLOWED_KEYS,
  DEFAULT_SILENCE_SEC,
  DEFAULT_STALL_TICKS,
  PANE_TAIL_BYTES,
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
  silentLoop.prevFingerprint = paneFingerprint(panes[0]);
  const silent = observerTick(silentLoop, panes[0], {
    mailboxAgeSec: DEFAULT_SILENCE_SEC,
    silenceSec: DEFAULT_SILENCE_SEC,
  });
  assert.equal(silent.event, "stall_detected");
  assert.equal(silent.trigger, "silence");
});

test("claude frozen working pane stalls but fresh mailbox blocks answer", () => {
  const working = readFixture("claude/working-40s.txt");
  const loop = createObserverLoop();
  const events = [];
  for (let i = 0; i < 5; i++) {
    const next = observerTick(loop, working, { mailboxAgeSec: 5 });
    Object.assign(loop, next);
    events.push(next.event);
  }
  assert.ok(events.includes("stall_detected"));

  const verdict = {
    state: "waiting_input",
    reason: "looks idle",
    action: "answer",
    keys: ["Enter"],
    evidence: "prompt",
  };
  const blocked = verifyVerdict(verdict, working, {
    mailboxAgeSec: 5,
    silenceSec: DEFAULT_SILENCE_SEC,
  });
  assert.equal(blocked.action, "wait");
  assert.match(blocked.reason, /mailbox fresh/);
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

test("credential pane escalates via deny pattern", () => {
  const pane = "Please enter your API key to continue\n> ";
  const verdict = {
    state: "waiting_input",
    reason: "needs key",
    action: "answer",
    keys: ["Enter"],
    evidence: "API key",
  };
  const result = verifyVerdict(verdict, pane, createObserverLoop());
  assert.equal(result.action, "escalate");
  assert.match(result.reason, /deny pattern/);
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
  assert.equal(loop.autoAnswerCount, 2);
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

test("getMailboxAge reflects newest file mtime", withTempRuns(async () => {
  const state = createRunWithTmux();
  const now = Date.now();
  touchMailbox(state.runId, "HEARTBEAT", "fresh");
  const age = getMailboxAge(state.runId, { now: () => now + 45_000 });
  assert.equal(age, 45);
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
    sleep: async () => {},
    capture: () => readFixture("cursor-agent/startup-idle-3s.txt"),
    parentPid: 1,
    isParentAlive: () => false,
    acquireLock: () => ({ ok: true }),
    keepLock: true,
    roster: TEST_ROSTER,
    usage: {},
  });
  assert.ok(true);
}));

test("runObserver second instance acquireLock failure exits immediately", withTempRuns(async () => {
  const state = createRunWithTmux();
  await runObserver(state.runId, {
    acquireLock: () => ({ ok: false, reason: "another observer is running" }),
  });
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
