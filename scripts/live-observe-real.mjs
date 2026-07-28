#!/usr/bin/env node
// Real end-to-end observer proof — real tmux, real roster judge, no mocks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as runs from "../src/runs/runs.mjs";
import { runObserver, DEFAULT_SILENCE_SEC } from "../src/runs/observe.mjs";
import { requireRoster, loadJson, usagePath } from "../src/roster/config.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(ROOT, "../test/fixtures/panes");

function readFixture(rel) {
  return fs.readFileSync(path.join(FIXTURES, rel), "utf8");
}

function tmux(...args) {
  return execFileSync("tmux", args, { encoding: "utf8" });
}

function killSession(name) {
  try {
    tmux("kill-session", "-t", name);
  } catch {
    // already gone
  }
}

function staleMailbox(mb, ageSec = DEFAULT_SILENCE_SEC + 30) {
  const staleTime = new Date(Date.now() - ageSec * 1000);
  for (const name of fs.readdirSync(mb)) {
    fs.utimesSync(path.join(mb, name), staleTime, staleTime);
  }
}

function touchHeartbeat(mb) {
  const hb = path.join(mb, "HEARTBEAT");
  fs.writeFileSync(hb, new Date().toISOString());
}

function startFrozenTrustPane(session) {
  killSession(session);
  const fixture = path.join(FIXTURES, "cursor-agent/trust-prompt-6s.txt");
  tmux("new-session", "-d", "-s", session, "-x", "120", "-y", "40", "bash", "-c",
    `cat ${JSON.stringify(fixture)}; exec sleep 3600`);
  execFileSync("sleep", ["1"]);
}

function tryStartHermes(session) {
  killSession(session);
  try {
    tmux("new-session", "-d", "-s", session, "hermes", "chat", "-q", "say hello", "--yolo");
    // Give hermes a moment to render
    execFileSync("sleep", ["3"]);
    const pane = tmux("capture-pane", "-t", session, "-p");
    if (/402|Insufficient Balance|error/i.test(pane)) {
      return { ok: false, error: pane.trim().slice(0, 500), pane };
    }
    return { ok: true, pane: pane.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function startAnimatedPane(session) {
  killSession(session);
  const script = [
    "#!/bin/bash",
    "trap exit INT TERM",
    "base=$(cat <<'FIXTURE'",
    readFixture("hermes/trust-prompt-6s.txt").trimEnd(),
    "FIXTURE",
    ")",
    "while true; do",
    "  clear",
    "  printf '%s\\n' \"$base\"",
    "  printf '\\n  [heartbeat %s]\\n' \"$(date +%H:%M:%S)\"",
    "  sleep 1",
    "done",
  ].join("\n");
  const scriptPath = path.join(os.tmpdir(), `animate-${session}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  tmux("new-session", "-d", "-s", session, "bash", scriptPath);
  execFileSync("sleep", ["2"]);
}

async function proveSilenceTrigger(dir, roster, usage) {
  const session = "observe-real-silence";
  const hermesTry = tryStartHermes(session);
  let workerCli = "hermes";
  let hermesNote = null;
  let syntheticPane = false;
  let paneSource = "live:hermes";

  if (!hermesTry.ok) {
    hermesNote = hermesTry.error;
    workerCli = "hermes";
    syntheticPane = true;
    paneSource = "fixture:hermes/trust-prompt-6s (animated fallback; cli label matches fixture)";
    startAnimatedPane(session);
  }

  const state = runs.createRun({
    cwd: dir,
    role: "implementer",
    parent: { cli: "cursor", attach: "manual" },
    worker: { cli: workerCli, tmux: session },
    prompt: "live proof case A",
  });
  runs.setStatus(state.runId, "watching");
  const mb = runs.mailboxDir(state.runId);
  staleMailbox(mb, 150);

  await runObserver(state.runId, {
    pollSec: 2,
    silenceSec: 12,
    stallTicks: 3,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    roster,
    usage,
    parentPid: process.pid,
    isParentAlive: () => true,
    keepLock: true,
  });

  killSession(session);

  const log = fs.existsSync(path.join(mb, "OBSERVATION.log"))
    ? fs.readFileSync(path.join(mb, "OBSERVATION.log"), "utf8")
    : "";
  const status = fs.existsSync(path.join(mb, "STATUS"))
    ? fs.readFileSync(path.join(mb, "STATUS"), "utf8").trim()
    : "";
  const questions = fs.existsSync(path.join(mb, "QUESTIONS.md"))
    ? fs.readFileSync(path.join(mb, "QUESTIONS.md"), "utf8")
    : "";

  // Infer trigger from log: silence stall fires when mailbox_age >= silence_sec
  const judgeLines = log.split("\n").filter((l) => l.includes('"kind":"judge_call"'));
  const decisionLines = log.split("\n").filter((l) => l.includes('"kind":"decision"'));

  return {
    case: "A-silence-trigger",
    syntheticPane,
    paneSource,
    runId: state.runId,
    workerCli,
    hermesNote,
    judgeModel: roster.roles?.observer?.chain?.[0] || "cursor:grok-4.5-high",
    status,
    log,
    questions,
    judgeLines,
    decisionLines,
  };
}

async function proveFreshMailboxRefusal(dir, roster, usage) {
  const session = "observe-real-fresh";
  startFrozenTrustPane(session);

  const state = runs.createRun({
    cwd: dir,
    role: "implementer",
    parent: { cli: "cursor", attach: "manual" },
    worker: { cli: "cursor-agent", tmux: session },
    prompt: "live proof case B",
  });
  runs.setStatus(state.runId, "watching");
  const mb = runs.mailboxDir(state.runId);

  let hbTimer;
  const startHeartbeat = () => {
    touchHeartbeat(mb);
    hbTimer = setInterval(() => touchHeartbeat(mb), 2000);
  };
  startHeartbeat();

  const obsPromise = runObserver(state.runId, {
    pollSec: 2,
    silenceSec: 120,
    stallTicks: 3,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    roster,
    usage,
    parentPid: process.pid,
    isParentAlive: () => true,
    keepLock: true,
  });

  await Promise.race([
    obsPromise,
    new Promise((r) => setTimeout(r, 60_000)),
  ]);

  clearInterval(hbTimer);
  killSession(session);

  const log = fs.existsSync(path.join(mb, "OBSERVATION.log"))
    ? fs.readFileSync(path.join(mb, "OBSERVATION.log"), "utf8")
    : "";
  const status = fs.existsSync(path.join(mb, "STATUS"))
    ? fs.readFileSync(path.join(mb, "STATUS"), "utf8").trim()
    : "";

  return {
    case: "B-fresh-mailbox-refusal",
    syntheticPane: true,
    paneSource: "fixture:cursor-agent/trust-prompt-6s (tmux cat)",
    runId: state.runId,
    workerCli: "cursor-agent",
    judgeModel: roster.roles?.observer?.chain?.[0] || "cursor:grok-4.5-high",
    status,
    log,
  };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-live-real-"));
  const prevRuns = process.env.TEAM_UP_RUNS;
  process.env.TEAM_UP_RUNS = dir;
  const roster = requireRoster();
  const usage = loadJson(usagePath()) || {};

  try {
    const caseA = await proveSilenceTrigger(dir, roster, usage);
    const caseB = await proveFreshMailboxRefusal(dir, roster, usage);
    console.log(JSON.stringify({ caseA, caseB }, null, 2));
  } finally {
    if (prevRuns === undefined) delete process.env.TEAM_UP_RUNS;
    else process.env.TEAM_UP_RUNS = prevRuns;
    fs.rmSync(dir, { recursive: true, force: true });
    killSession("observe-real-silence");
    killSession("observe-real-fresh");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
