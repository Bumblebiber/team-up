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
  appendObservationLog,
  observationLogPath,
  escalateRun,
  MAX_AUTO_ANSWERS,
  ALLOWED_KEYS,
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

test("normalizePaneText trims trailing whitespace per line only", () => {
  const raw = "hello   \n  world \n";
  assert.equal(normalizePaneText(raw), "hello\n  world\n");
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
    const next = observerTick(loop, pane);
    Object.assign(loop, next);
    if (next.event === "stall_detected") judgeCalls++;
  }
  assert.equal(judgeCalls, 0);
  assert.ok(panes.every((p, i) => i === 0 || paneFingerprint(p) !== paneFingerprint(panes[i - 1])));
});

test("frozen startup-idle pane trips stall after exactly 3 identical captures", () => {
  const frozen = readFixture("cursor-agent/startup-idle-3s.txt");
  const loop = createObserverLoop();
  const events = [];
  for (let i = 0; i < 6; i++) {
    const next = observerTick(loop, frozen);
    Object.assign(loop, next);
    events.push(next.event);
  }
  assert.deepEqual(
    events.filter((e) => e === "stall_detected"),
    ["stall_detected"],
  );
  assert.deepEqual(
    events.slice(3),
    ["stall_ongoing", "stall_ongoing", "stall_ongoing"],
  );
});

test("trust-prompt verdict with allowlisted keys is honoured", () => {
  const pane = readFixture("cursor-agent/trust-prompt-6s.txt");
  const verdict = {
    state: "waiting_input",
    reason: "trust dialog",
    action: "answer",
    keys: ["Enter"],
    evidence: "Trust this workspace",
  };
  const result = verifyVerdict(verdict, pane, createObserverLoop());
  assert.equal(result.action, "answer");
  assert.deepEqual(result.keys, ["Enter"]);
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

test("credential pane escalates even when model says answer", () => {
  const pane = "Please enter your API key to continue\n> ";
  const verdict = {
    state: "login_required",
    reason: "needs key",
    action: "answer",
    keys: ["Enter"],
    evidence: "API key",
  };
  const result = verifyVerdict(verdict, pane, createObserverLoop());
  assert.equal(result.action, "escalate");
  assert.match(result.reason, /deny pattern/);
  assert.ok(matchesDenyPattern(pane));
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
    },
  });
  assert.equal(r1.stop, true);
  assert.equal(runs.loadState(state.runId).status, "waiting_human");
  assert.equal(loop.judgeFailedEscalated, true);

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
    },
  });
  assert.equal(r2.stop, false);
  assert.equal(logs.filter((l) => l.kind === "decision" && l.action === "escalate").length, 1);
}));

test("garbage judge output escalates", withTempRuns(async () => {
  const state = createRunWithTmux();
  const loop = createObserverLoop();
  const result = handleStall({
    runId: state.runId,
    state,
    loop,
    capture: "frozen",
    deps: {
      roster: TEST_ROSTER,
      usage: {},
      judge: () => ({ ok: true, stdout: "not json at all" }),
      log: () => {},
      now: () => Date.now(),
    },
  });
  assert.equal(result.stop, true);
  assert.equal(runs.loadState(state.runId).status, "waiting_human");
}));

test("unknown state escalates", withTempRuns(async () => {
  const state = createRunWithTmux();
  const loop = createObserverLoop();
  const verdict = {
    state: "unknown",
    reason: "cannot tell",
    action: "wait",
    evidence: "???",
  };
  const result = handleStall({
    runId: state.runId,
    state,
    loop,
    capture: "???",
    deps: {
      roster: TEST_ROSTER,
      usage: {},
      judge: () => ({ ok: true, stdout: JSON.stringify(verdict) }),
      log: () => {},
      now: () => Date.now(),
    },
  });
  assert.equal(result.stop, true);
}));

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
  const result = verifyVerdict(verdict, "same pane", loop);
  assert.equal(result.action, "escalate");
  assert.match(result.reason, /auto-answer cap/);
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
  const result = verifyVerdict(verdict, pane, loop);
  assert.equal(result.action, "escalate");
  assert.match(result.reason, /repeat-pane/);
});

test("handleStall sends keys and logs answer", withTempRuns(async () => {
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
    },
  });
  assert.equal(result.stop, false);
  assert.deepEqual(sent, ["Enter"]);
  assert.equal(result.loop.autoAnswerCount, 1);
  assert.ok(logs.some((l) => l.kind === "action" && l.action === "answer"));
}));

test("OBSERVATION.log appends one JSON object per line", withTempRuns(async (dir) => {
  const state = createRunWithTmux();
  const entries = [];
  appendObservationLog(state.runId, { kind: "test", foo: 1 }, {
    appendFile: (p, line) => entries.push({ p, line }),
  });
  assert.equal(entries.length, 1);
  const parsed = JSON.parse(entries[0].line.trim());
  assert.equal(parsed.kind, "test");
  assert.equal(parsed.foo, 1);
  assert.ok(parsed.ts);
}));

test("escalateRun writes QUESTIONS.md and waiting_human status", withTempRuns(async () => {
  const state = createRunWithTmux();
  escalateRun(state.runId, "Need human help");
  const mb = runs.mailboxDir(state.runId);
  assert.equal(fs.readFileSync(path.join(mb, "STATUS"), "utf8").trim(), "waiting_human");
  assert.match(fs.readFileSync(path.join(mb, "QUESTIONS.md"), "utf8"), /Need human help/);
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
  assert.deepEqual(r.verdict.keys, ["Enter"]);
});

test("parseJudgeJson extracts JSON from surrounding text", () => {
  const wrapped = 'Here is my verdict:\n{"state":"working","reason":"ok","action":"wait","evidence":"x"}\nDone.';
  const r = parseJudgeJson(wrapped);
  assert.equal(r.ok, true);
  assert.equal(r.verdict.state, "working");
});

test("all ALLOWED_KEYS are accepted in verifyVerdict", () => {
  for (const key of ALLOWED_KEYS) {
    const result = verifyVerdict({
      state: "waiting_input",
      reason: "t",
      action: "answer",
      keys: [key],
      evidence: "e",
    }, "pane", createObserverLoop());
    assert.equal(result.action, "answer", `key ${key} should be allowed`);
  }
});

test("working panes across all five CLIs never stall in fixture sequences", () => {
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
      const next = observerTick(loop, pane);
      Object.assign(loop, next);
      if (next.event === "stall_detected") stalls++;
    }
    assert.equal(stalls, 0, `${meta.cli} working fixtures should not stall`);
  }
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
