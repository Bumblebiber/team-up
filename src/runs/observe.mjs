#!/usr/bin/env node
// observe.mjs — adaptive pane observation loop for waitMailbox.
// Polls tmux, detects stalls, calls a roster observer judge, verifies proposals in code.

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  atomicWriteText,
  captureTmuxPane,
  loadState,
  mailboxDir,
  setStatus,
} from "./runs.mjs";
import { pick } from "../roster/chain.mjs";
import { loadJson, requireRoster, usagePath } from "../roster/config.mjs";

export const DEFAULT_POLL_SEC = 5;
export const DEFAULT_STALL_TICKS = 3;
export const DEFAULT_SILENCE_SEC = 120;
export const JUDGE_TIMEOUT_MS = 60_000;
export const MAX_AUTO_ANSWERS = 3;
export const PANE_TAIL_BYTES = 8 * 1024;
export const OBSERVER_PID_FILE = "OBSERVER.pid";

export const ALLOWED_KEYS = new Set([
  "Enter", "Escape", "Up", "Down", "Left", "Right", "Tab", "Space",
  "y", "n", "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);

export const DENY_PATTERNS = [
  /\blogin\b/i,
  /\bsign\s*in\b/i,
  /\bauthenticate\b/i,
  /\bdevice\s*code\b/i,
  /\bverification\s*code\b/i,
  /\bapi\s*key\b/i,
  /\btoken\b/i,
  /\bpassword\b/i,
  /\bbilling\b/i,
  /\bpayment\b/i,
  /\bsubscribe\b/i,
  /\bupgrade\s*plan\b/i,
];

const VALID_STATES = new Set([
  "working", "waiting_input", "finished", "crashed", "login_required", "unknown",
]);
const VALID_ACTIONS = new Set(["wait", "answer", "escalate"]);

/** Trim trailing whitespace per line; preserve spinners and counters. */
export function normalizePaneText(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

export function paneFingerprint(text) {
  return normalizePaneText(text);
}

export function tailPane(text, maxBytes = PANE_TAIL_BYTES) {
  const buf = Buffer.from(String(text || ""), "utf8");
  if (buf.length <= maxBytes) return buf.toString("utf8");
  return buf.subarray(buf.length - maxBytes).toString("utf8");
}

export function matchesDenyPattern(pane) {
  const text = String(pane || "");
  return DENY_PATTERNS.some((re) => re.test(text));
}

export function parseJudgeJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "empty judge output" };

  const tryParse = (slice) => {
    try {
      return JSON.parse(slice);
    } catch {
      return null;
    }
  };

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { ok: false, error: "no JSON object in judge output" };
  }

  const outer = tryParse(raw.slice(start, end + 1));
  if (!outer) {
    return { ok: false, error: "malformed JSON in judge output" };
  }

  // cursor-agent --output-format json wraps the model text in { type, result }.
  if (outer.type === "result" && typeof outer.result === "string") {
    const innerStart = outer.result.indexOf("{");
    const innerEnd = outer.result.lastIndexOf("}");
    if (innerStart !== -1 && innerEnd > innerStart) {
      const inner = tryParse(outer.result.slice(innerStart, innerEnd + 1));
      if (inner && typeof inner.state === "string") {
        return { ok: true, verdict: inner };
      }
    }
    const innerDirect = tryParse(outer.result.trim());
    if (innerDirect && typeof innerDirect.state === "string") {
      return { ok: true, verdict: innerDirect };
    }
  }

  if (typeof outer.state === "string") {
    return { ok: true, verdict: outer };
  }

  return { ok: false, error: "no verdict object in judge output" };
}

export function validateVerdictShape(verdict) {
  if (!verdict || typeof verdict !== "object") {
    return { ok: false, error: "verdict is not an object" };
  }
  if (!VALID_STATES.has(verdict.state)) {
    return { ok: false, error: `unknown state: ${verdict.state}` };
  }
  if (!VALID_ACTIONS.has(verdict.action)) {
    return { ok: false, error: `unknown action: ${verdict.action}` };
  }
  if (verdict.action === "answer") {
    if (!Array.isArray(verdict.keys) || verdict.keys.length === 0) {
      return { ok: false, error: "answer action requires non-empty keys array" };
    }
  }
  return { ok: true };
}

/**
 * Code-side verification. Returns { action, reason, verdict }.
 * @param {object} ctx — { autoAnswerCount, answeredPanes: Set<string> }
 */
export function verifyVerdict(verdict, pane, ctx = {}) {
  const shape = validateVerdictShape(verdict);
  if (!shape.ok) {
    return {
      action: "escalate",
      reason: shape.error,
      question: `Observer judge returned invalid verdict: ${shape.error}`,
      verdict,
    };
  }

  if (verdict.state === "unknown") {
    return {
      action: "escalate",
      reason: "unknown state",
      question: verdict.question || "Worker pane stalled with unknown state.",
      verdict,
    };
  }

  if (verdict.state === "login_required") {
    return {
      action: "escalate",
      reason: "login_required state",
      question: verdict.question || "Login or authentication required.",
      verdict,
    };
  }

  if (matchesDenyPattern(pane)) {
    return {
      action: "escalate",
      reason: "deny pattern matched in pane",
      question: verdict.question || "Pane contains credential or billing wording; human required.",
      verdict,
    };
  }

  if (verdict.action === "wait") {
    return { action: "wait", reason: "judge said wait", verdict };
  }

  if (verdict.action === "escalate") {
    return {
      action: "escalate",
      reason: "judge requested escalate",
      question: verdict.question || "Worker pane needs human attention.",
      verdict,
    };
  }

  // action === "answer"
  const silenceSec = ctx.silenceSec ?? DEFAULT_SILENCE_SEC;
  const mailboxAgeSec = ctx.mailboxAgeSec ?? Infinity;
  if (mailboxAgeSec < silenceSec) {
    return {
      action: "wait",
      reason: "mailbox fresh; worker likely alive despite frozen pane",
      verdict,
    };
  }

  const fp = paneFingerprint(pane);
  if (ctx.answeredPanes?.has(fp)) {
    return {
      action: "escalate",
      reason: "repeat-pane guard",
      question: "Observer already answered this pane; not repeating.",
      verdict,
    };
  }

  if ((ctx.autoAnswerCount ?? 0) >= MAX_AUTO_ANSWERS) {
    return {
      action: "escalate",
      reason: "auto-answer cap reached",
      question: verdict.question || `Auto-answer cap (${MAX_AUTO_ANSWERS}) reached.`,
      verdict,
    };
  }

  for (const key of verdict.keys) {
    if (!ALLOWED_KEYS.has(key)) {
      return {
        action: "escalate",
        reason: `disallowed key: ${key}`,
        question: `Judge proposed non-allowlisted key "${key}".`,
        verdict,
      };
    }
  }

  return { action: "answer", reason: "verified answer", verdict, keys: verdict.keys };
}

export function buildJudgePrompt({
  pane,
  cli,
  runId,
  role,
  elapsedSec,
  mailboxAgeSec = Infinity,
  silenceSec = DEFAULT_SILENCE_SEC,
}) {
  return [
    "You are an observer judging a frozen terminal pane from a coding CLI worker.",
    "Return ONLY a single JSON object, no markdown fences.",
    "",
    "Schema:",
    '{"state":"working|waiting_input|finished|crashed|login_required|unknown",',
    '"reason":"one sentence",',
    '"action":"wait|answer|escalate",',
    '"keys":["Down","Enter"],',
    '"question":"text when action=escalate",',
    '"evidence":"quoted pane lines"}',
    "",
    `run_id: ${runId}`,
    `cli: ${cli}`,
    `role: ${role}`,
    `elapsed_sec: ${elapsedSec}`,
    `mailbox_age_sec: ${mailboxAgeSec}`,
    `silence_sec: ${silenceSec}`,
    "",
    "Important: A frozen terminal screen is NOT evidence of idleness.",
    "If mailbox_age_sec is less than silence_sec, the worker is likely alive.",
    "",
    "Pane (last ~8KiB):",
    tailPane(pane),
  ].join("\n");
}

/** Observer role pick; never returns claude. */
export function resolveObserverJudge(roster, usage, now = Date.now()) {
  const picked = pick({ roster, usage, role: "observer", now });
  if (!picked.model || !picked.cli) {
    return { ok: false, error: "no observer model available", skipped: picked.skipped };
  }
  if (picked.cli === "claude") {
    return { ok: false, error: "observer judge must not be claude", skipped: picked.skipped };
  }
  return { ok: true, model: picked.model, cli: picked.cli, effort: picked.effort };
}

export function buildJudgeArgv({ roster, cli, model, prompt, effort = null }) {
  const cliModel = roster.models?.[model]?.cli_model || model;
  if (cli === "cursor") {
    const argv = [
      "cursor-agent", "-p", "--output-format", "json",
      "--model", cliModel, prompt,
    ];
    return argv;
  }
  if (cli === "codex") {
    const argv = ["codex", "exec", "--model", cliModel];
    if (effort) argv.push("-c", `model_reasoning_effort=${effort}`);
    argv.push(prompt);
    return argv;
  }
  const template = roster.clis?.[cli]?.cmd;
  if (!template) throw new Error(`no cli template for observer judge: ${cli}`);
  const argv = [];
  for (let i = 0; i < template.length; i++) {
    const part = template[i];
    if (part.includes("{effort}") && !effort) {
      if (argv.length && template[i - 1]?.startsWith("-")) argv.pop();
      continue;
    }
    argv.push(
      part.replaceAll("{model}", cliModel)
        .replaceAll("{prompt}", prompt)
        .replaceAll("{effort}", effort ?? ""),
    );
  }
  if (cli === "claude") {
    throw new Error("observer judge must not use claude");
  }
  return argv;
}

export function observationLogPath(runId) {
  return path.join(mailboxDir(runId), "OBSERVATION.log");
}

export function appendObservationLog(runId, entry, { appendFile = defaultAppend } = {}) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  appendFile(observationLogPath(runId), line);
}

function defaultAppend(filePath, line) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line);
}

function readMaybe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Seconds since the newest mtime in the mailbox directory. */
export function getMailboxAge(runId, { now = () => Date.now(), stat = fs.statSync } = {}) {
  const mb = mailboxDir(runId);
  if (!fs.existsSync(mb)) return Infinity;
  let latest = 0;
  for (const name of fs.readdirSync(mb)) {
    try {
      const st = stat(path.join(mb, name));
      if (st.mtimeMs > latest) latest = st.mtimeMs;
    } catch {
      // skip unreadable entries
    }
  }
  if (latest === 0) return Infinity;
  return Math.floor((now() - latest) / 1000);
}

export function observerPidPath(runId) {
  return path.join(mailboxDir(runId), OBSERVER_PID_FILE);
}

/** Acquire exclusive observer lock; second live observer must not run. */
export function tryAcquireObserverLock(runId, { pid = process.pid, writeFile = fs.writeFileSync } = {}) {
  const lockPath = observerPidPath(runId);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${pid}\n`);
    fs.closeSync(fd);
    return { ok: true, lockPath };
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const existing = Number(String(readMaybe(lockPath) || "").trim());
    if (existing && isProcessAlive(existing) && existing !== pid) {
      return { ok: false, reason: "another observer is running", existingPid: existing };
    }
    writeFile(lockPath, `${pid}\n`);
    return { ok: true, lockPath, replacedStale: true };
  }
}

export function releaseObserverLock(runId) {
  const lockPath = observerPidPath(runId);
  try {
    fs.unlinkSync(lockPath);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

/** Restore per-run caps from OBSERVATION.log. */
export function hydrateLoopFromLog(runId, loop = createObserverLoop()) {
  const logPath = observationLogPath(runId);
  if (!fs.existsSync(logPath)) return loop;
  for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.kind === "action" && entry.action === "answer") {
      loop.autoAnswerCount = Math.max(loop.autoAnswerCount, entry.auto_answer_count ?? 0);
      if (entry.pane_fp) loop.answeredPanes.add(entry.pane_fp);
    }
  }
  return loop;
}

export function escalateRun(runId, question, { source = "observer" } = {}) {
  const questionsPath = path.join(mailboxDir(runId), "QUESTIONS.md");
  const existing = readMaybe(questionsPath);
  const newBlock = [
    `<!-- source: ${source} -->`,
    "",
    String(question || "Worker pane needs human attention.").trim(),
    "",
  ].join("\n");
  const body = existing?.trim()
    ? `${existing.trimEnd()}\n\n---\n\n${newBlock}`
    : newBlock;
  atomicWriteText(questionsPath, body);
  setStatus(runId, "waiting_human");
}

export function sendTmuxKeys(session, keys, { execFile = execFileSync } = {}) {
  for (const key of keys) {
    execFile("tmux", ["send-keys", "-t", session, key], { stdio: "ignore" });
  }
}

export function defaultCapture(session, { execFile = execFileSync } = {}) {
  try {
    return execFile("tmux", ["capture-pane", "-t", session, "-pJ"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function defaultJudgeCall({ argv, timeoutMs = JUDGE_TIMEOUT_MS }) {
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (r.error) {
    return { ok: false, error: r.error.message, stdout: r.stdout || "", stderr: r.stderr || "" };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      error: `exit ${r.status}`,
      stdout: r.stdout || "",
      stderr: r.stderr || "",
    };
  }
  return { ok: true, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** Pure tick for tests — advances observer state machine one step. */
export function observerTick(loop, capture, deps = {}) {
  const stallTicks = deps.stallTicks ?? DEFAULT_STALL_TICKS;
  const silenceSec = deps.silenceSec ?? DEFAULT_SILENCE_SEC;
  const mailboxAgeSec = deps.mailboxAgeSec ?? Infinity;
  const fp = paneFingerprint(capture);

  if (fp !== loop.prevFingerprint) {
    const hadPrior = loop.prevFingerprint != null;
    loop.prevFingerprint = fp;
    loop.identicalCount = 0;
    if (hadPrior) {
      loop.awaitingPostAnswer = false;
      loop.postAnswerTicks = 0;
    }
    loop.judgeCalledThisEpisode = false;
    return { ...loop, event: "changed" };
  }

  loop.identicalCount += 1;

  if (loop.awaitingPostAnswer) {
    loop.postAnswerTicks += 1;
    if (loop.postAnswerTicks >= stallTicks) {
      return { ...loop, event: "post_answer_stall", capture };
    }
    return { ...loop, event: "post_answer_wait" };
  }

  const paneStalled = loop.identicalCount >= stallTicks;
  const silenceStalled = mailboxAgeSec >= silenceSec;

  if (!paneStalled && !silenceStalled) {
    return { ...loop, event: "identical" };
  }
  if (loop.judgeCalledThisEpisode) {
    return { ...loop, event: "stall_ongoing" };
  }

  loop.judgeCalledThisEpisode = true;
  const trigger = silenceStalled && !paneStalled ? "silence" : "pane";
  return { ...loop, event: "stall_detected", capture, trigger };
}

export function createObserverLoop() {
  return {
    prevFingerprint: null,
    identicalCount: 0,
    judgeCalledThisEpisode: false,
    autoAnswerCount: 0,
    answeredPanes: new Set(),
    judgeFailedEscalated: false,
    escalated: false,
    postAnswerTicks: 0,
    awaitingPostAnswer: false,
  };
}

/**
 * Run one stall episode: judge + verify + act.
 * Returns updated loop and whether observer should stop.
 */
export function handleStall({
  runId,
  state,
  loop,
  capture,
  deps = {},
}) {
  const {
    judge = defaultJudgeCall,
    roster = deps.roster,
    usage = deps.usage,
    now = deps.now ?? (() => Date.now()),
    log = (entry) => appendObservationLog(runId, entry, deps),
    escalate = (q) => escalateRun(runId, q, deps),
    sendKeys = (keys) => sendTmuxKeys(state.worker.tmux, keys, deps),
    dispatchStart = state.createdAt ? Date.parse(state.createdAt) : Date.now(),
    silenceSec = DEFAULT_SILENCE_SEC,
    mailboxAgeSec = getMailboxAge(runId, { now }),
  } = deps;

  const elapsedSec = Math.round((now() - dispatchStart) / 1000);
  const cli = state.worker?.cli || "unknown";
  const role = state.role || "worker";

  const prompt = buildJudgePrompt({
    pane: capture,
    cli,
    runId,
    role,
    elapsedSec,
    mailboxAgeSec,
    silenceSec,
  });

  let judgeResult;
  let verdict;
  try {
    const pickResult = resolveObserverJudge(roster, usage, now());
    if (!pickResult.ok) {
      judgeResult = { ok: false, error: pickResult.error };
    } else {
      const argv = buildJudgeArgv({
        roster,
        cli: pickResult.cli,
        model: pickResult.model,
        prompt,
        effort: pickResult.effort,
      });
      judgeResult = judge({ argv });
      if (judgeResult.ok) {
        const parsed = parseJudgeJson(judgeResult.stdout);
        if (!parsed.ok) {
          judgeResult = { ok: false, error: parsed.error, stdout: judgeResult.stdout };
        } else {
          verdict = parsed.verdict;
        }
      }
    }
  } catch (e) {
    judgeResult = { ok: false, error: e.message };
  }

  log({
    kind: "judge_call",
    cli,
    role,
    elapsed_sec: elapsedSec,
    ok: judgeResult.ok,
    error: judgeResult.error || null,
    verdict: verdict || null,
  });

  if (!judgeResult.ok || !verdict) {
    if (loop.judgeFailedEscalated) {
      log({ kind: "decision", action: "wait", reason: "judge failure already escalated" });
      return { loop, stop: false };
    }
    loop.judgeFailedEscalated = true;
    const question = `Observer judge failed: ${judgeResult.error || "no verdict"}`;
    log({ kind: "decision", action: "escalate", reason: "judge error", question });
    escalate(question);
    loop.escalated = true;
    return { loop, stop: true };
  }

  const verified = verifyVerdict(verdict, capture, {
    ...loop,
    silenceSec,
    mailboxAgeSec,
  });
  log({
    kind: "decision",
    proposed_action: verdict.action,
    action: verified.action,
    reason: verified.reason,
    keys: verified.keys || null,
  });

  if (verified.action === "wait") {
    return { loop, stop: false };
  }

  if (verified.action === "escalate") {
    escalate(verified.question);
    loop.escalated = true;
    return { loop, stop: true };
  }

  // answer
  const fp = paneFingerprint(capture);
  sendKeys(verified.keys);
  loop.answeredPanes.add(fp);
  loop.autoAnswerCount += 1;
  loop.awaitingPostAnswer = true;
  loop.postAnswerTicks = 0;
  log({
    kind: "action",
    action: "answer",
    keys: verified.keys,
    auto_answer_count: loop.autoAnswerCount,
    pane_fp: fp,
  });
  return { loop, stop: false };
}

export function handlePostAnswerStall({
  runId,
  loop,
  deps = {},
}) {
  const {
    log = (entry) => appendObservationLog(runId, entry, deps),
    escalate = (q) => escalateRun(runId, q, deps),
  } = deps;
  const question = "Pane unchanged after auto-answer; escalating.";
  log({ kind: "decision", action: "escalate", reason: "post-answer stall", question });
  escalate(question);
  loop.escalated = true;
  loop.awaitingPostAnswer = false;
  return { loop, stop: true };
}

export async function runObserver(runId, deps = {}) {
  const pollSec = (deps.pollSec ?? DEFAULT_POLL_SEC) * 1000;
  const silenceSec = deps.silenceSec ?? DEFAULT_SILENCE_SEC;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const shouldStop = deps.shouldStop ?? (() => false);
  const captureFn = deps.capture ?? ((session) => defaultCapture(session));
  const parentPid = deps.parentPid ?? process.ppid;
  const isParentAlive = deps.isParentAlive ?? ((pid) => isProcessAlive(pid));

  const lock = deps.acquireLock ?? (() => tryAcquireObserverLock(runId, deps));
  const lockResult = lock();
  if (!lockResult.ok) {
    return;
  }

  let roster = deps.roster;
  let usage = deps.usage;
  if (!roster) {
    try {
      roster = requireRoster();
      usage = loadJson(usagePath()) || {};
    } catch {
      roster = null;
    }
  }

  const loop = hydrateLoopFromLog(runId, createObserverLoop());

  try {
    while (!shouldStop() && !loop.escalated) {
      if (!isParentAlive(parentPid)) break;

      const state = loadState(runId);
      if (!state) break;
      const session = state.worker?.tmux;
      if (!session) break;

      const status = fs.existsSync(path.join(mailboxDir(runId), "STATUS"))
        ? fs.readFileSync(path.join(mailboxDir(runId), "STATUS"), "utf8").trim()
        : "";
      if (["done", "failed", "cancelled", "waiting_human"].includes(status)) break;

      const capture = captureFn(session);
      const mailboxAgeSec = deps.mailboxAgeSec ?? getMailboxAge(runId, { now });
      const next = observerTick(loop, capture, { ...deps, silenceSec, mailboxAgeSec });
      Object.assign(loop, next);

      if (next.event === "stall_detected") {
        const result = handleStall({
          runId,
          state,
          loop,
          capture: next.capture,
          deps: { ...deps, roster, usage, now, silenceSec, mailboxAgeSec },
        });
        Object.assign(loop, result.loop);
        if (result.stop) break;
      } else if (next.event === "post_answer_stall") {
        const result = handlePostAnswerStall({
          runId,
          loop,
          deps,
        });
        Object.assign(loop, result.loop);
        if (result.stop) break;
      }

      await sleep(pollSec);
    }
  } finally {
    if (!deps.keepLock) releaseObserverLock(runId);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function spawnObserver(runId, deps = {}) {
  const script = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [script, runId], {
    stdio: "ignore",
    detached: false,
    env: { ...process.env },
  });
  return child;
}

function main() {
  const runId = process.argv[2];
  if (!runId) {
    console.error("usage: observe.mjs <runId>");
    process.exit(1);
  }
  runObserver(runId).catch((e) => {
    console.error(`observer error: ${e.message}`);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
