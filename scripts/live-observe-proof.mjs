#!/usr/bin/env node
// Live proof for adaptive pane observer — hermes silence + cursor-agent pane stall.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as runs from "../src/runs/runs.mjs";
import { runObserver, DEFAULT_SILENCE_SEC } from "../src/runs/observe.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(ROOT, "../test/fixtures/panes");

function readFixture(rel) {
  return fs.readFileSync(path.join(FIXTURES, rel), "utf8");
}

function staleMailbox(mb, ageSec = DEFAULT_SILENCE_SEC + 30) {
  const staleTime = new Date(Date.now() - ageSec * 1000);
  for (const name of fs.readdirSync(mb)) {
    fs.utimesSync(path.join(mb, name), staleTime, staleTime);
  }
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

function showPane(session, text) {
  const tmp = path.join(os.tmpdir(), `pane-${session}.txt`);
  fs.writeFileSync(tmp, text);
  tmux("send-keys", "-t", session, "C-l");
  tmux("load-buffer", tmp);
  tmux("paste-buffer", "-t", session, "-d");
}

async function proveHermesSilence(dir) {
  const session = "observe-proof-hermes";
  killSession(session);
  const pane6 = readFixture("hermes/trust-prompt-6s.txt");
  const pane10 = readFixture("hermes/trust-prompt-10s.txt");
  let tick = 0;
  const capture = () => {
    const pane = tick % 2 === 0 ? pane6 : pane10;
    tick += 1;
    return pane;
  };

  const state = runs.createRun({
    cwd: dir,
    role: "implementer",
    parent: { cli: "cursor", attach: "manual" },
    worker: { cli: "hermes", tmux: session },
    prompt: "proof",
  });
  runs.setStatus(state.runId, "watching");
  const mb = runs.mailboxDir(state.runId);
  staleMailbox(mb, 150);

  const obsPromise = runObserver(state.runId, {
    pollSec: 2,
    silenceSec: 12,
    mailboxAgeSec: 150,
    capture: () => capture(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    roster: {
      clis: { cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] } },
      models: { "grok-4.5-high": { provider: "xai", cli: ["cursor"] } },
      roles: { observer: { chain: ["cursor:grok-4.5-high"] } },
    },
    usage: {},
    judge: () => ({
      ok: true,
      stdout: JSON.stringify({
        state: "waiting_input",
        reason: "hermes trust dialog with ticking footer",
        action: "escalate",
        question: "Hermes stuck at trust dialog; mailbox silent.",
        evidence: "trust",
      }),
    }),
    parentPid: process.pid,
    isParentAlive: () => true,
  });

  await Promise.race([
    obsPromise,
    new Promise((r) => setTimeout(r, 20_000)),
  ]);

  const log = fs.existsSync(path.join(mb, "OBSERVATION.log"))
    ? fs.readFileSync(path.join(mb, "OBSERVATION.log"), "utf8")
    : "";
  const questions = fs.existsSync(path.join(mb, "QUESTIONS.md"))
    ? fs.readFileSync(path.join(mb, "QUESTIONS.md"), "utf8")
    : "";
  const status = fs.readFileSync(path.join(mb, "STATUS"), "utf8").trim();
  return { case: "hermes-silence", runId: state.runId, status, log, questions };
}

async function proveCursorFrozen(dir) {
  const session = "observe-proof-cursor";
  killSession(session);
  tmux("new-session", "-d", "-s", session, "sleep", "3600");
  const frozen = readFixture("cursor-agent/startup-idle-3s.txt");
  showPane(session, frozen);

  const state = runs.createRun({
    cwd: dir,
    role: "implementer",
    parent: { cli: "cursor", attach: "manual" },
    worker: { cli: "cursor-agent", tmux: session },
    prompt: "proof",
  });
  runs.setStatus(state.runId, "watching");
  const mb = runs.mailboxDir(state.runId);
  staleMailbox(mb, 150);

  const obsPromise = runObserver(state.runId, {
    pollSec: 2,
    silenceSec: 120,
    mailboxAgeSec: 150,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    roster: {
      clis: { cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] } },
      models: { "grok-4.5-high": { provider: "xai", cli: ["cursor"] } },
      roles: { observer: { chain: ["cursor:grok-4.5-high"] } },
    },
    usage: {},
    judge: () => ({
      ok: true,
      stdout: JSON.stringify({
        state: "waiting_input",
        reason: "idle prompt",
        action: "escalate",
        question: "Cursor-agent pane frozen at startup idle.",
        evidence: "idle",
      }),
    }),
    parentPid: process.pid,
    isParentAlive: () => true,
  });

  await Promise.race([
    obsPromise,
    new Promise((r) => setTimeout(r, 20_000)),
  ]);
  killSession(session);

  const log = fs.existsSync(path.join(mb, "OBSERVATION.log"))
    ? fs.readFileSync(path.join(mb, "OBSERVATION.log"), "utf8")
    : "";
  const questions = fs.existsSync(path.join(mb, "QUESTIONS.md"))
    ? fs.readFileSync(path.join(mb, "QUESTIONS.md"), "utf8")
    : "";
  const status = fs.readFileSync(path.join(mb, "STATUS"), "utf8").trim();
  return { case: "cursor-frozen", runId: state.runId, status, log, questions };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-live-proof-"));
  const prev = process.env.TEAM_UP_RUNS;
  process.env.TEAM_UP_RUNS = dir;
  try {
    const hermes = await proveHermesSilence(dir);
    const cursor = await proveCursorFrozen(dir);
    console.log(JSON.stringify({ hermes, cursor }, null, 2));
  } finally {
    if (prev === undefined) delete process.env.TEAM_UP_RUNS;
    else process.env.TEAM_UP_RUNS = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    killSession("observe-proof-hermes");
    killSession("observe-proof-cursor");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
