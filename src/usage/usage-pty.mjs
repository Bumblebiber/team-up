// usage-pty.mjs — expect-based interactive slash-command collector (codex/cursor; claude fallback).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  codexTrustFlag,
  dialogBranches,
  fastExitBlock,
  homeDir,
  shellEscape,
  spawnLine,
  timeoutTail,
} from "./pty-expect-core.mjs";

const COLLECT_ENV = { O9K_USAGE_COLLECT: "1", TEAM_UP_USAGE_COLLECT: "1", TERM: "xterm-256color" };

/** Mirrors parse-codex-status.mjs LIMIT_LINE_RE — wait for real quota output. */
const CODEX_LIMIT_WAIT = "Weekly limit:";
const CODEX_LIMIT_WAIT_ALT = "5h limit:";
const CODEX_HIT_LIMIT_WAIT = "hit your usage limit";
/** Full line with resets — short "5h limit:" false-matches ANSI fragments like "[?25h". */
const CODEX_LIMIT_READY_RE = "limit:.*% left.*resets";
const CODEX_STATUS_BAR_RE = "weekly .*% left";

const SEQUENCES = {
  claude: { bin: "claude", command: "/usage", wait: "Current session", exit: "/exit" },
  codex: {
    bin: "codex",
    command: "/status",
    ready: "Tip:",
    wait: CODEX_LIMIT_WAIT,
    waitAlt: CODEX_LIMIT_WAIT_ALT,
    waitHit: CODEX_HIT_LIMIT_WAIT,
    exit: "/exit",
    cols: 120,
    rows: 40,
  },
  cursor: {
    bin: "cursor-agent",
    command: "/usage",
    ready: "Tip:",
    accept: "Show plan",
    // The panel's closing line, not its first row: waiting on "Included" can
    // return before the Auto and API rows beneath it have rendered.
    wait: "Esc to close",
    exit: "/exit",
    cols: 120,
    rows: 40,
  },
};

const SECRET_RE =
  /sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]+|sk-proj-[A-Za-z0-9_-]+|Bearer [A-Za-z0-9_-]{20,}|[0-9a-f]{48,}/gi;

function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x1b\\]*(?:\x1b\\|\x07)/g, "");
}

function unwrapContinuationLines(text) {
  return String(text).replace(/([^\n])\n(?=[ \t]|sk-)/g, "$1");
}

export function normalizeForRedaction(text) {
  return unwrapContinuationLines(stripAnsi(text));
}

export function redactSecrets(text) {
  return normalizeForRedaction(text).replace(SECRET_RE, "[REDACTED]");
}

export function redactPaneExcerpt(text, lineCount = 15) {
  if (!text || typeof text !== "string") return "(empty pane)";
  const lines = normalizeForRedaction(text).replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-lineCount).join("\n");
  return redactSecrets(tail);
}

export function formatPtyTimeoutError(cli, transcript = "", stderr = "") {
  const raw = [transcript, stderr].filter(Boolean).join("\n");
  const marker = "PTY_TIMEOUT_TAIL:\n";
  const idx = raw.lastIndexOf(marker);
  const excerpt = idx >= 0 ? raw.slice(idx + marker.length) : raw;
  return `${cli} collect timed out — last pane lines:\n${redactPaneExcerpt(excerpt)}`;
}

/** expect stderr when /exit is sent after codex already closed the PTY. */
export function isClosedSpawnExit(stderr = "") {
  return /spawn id .* not open/i.test(stderr);
}

/**
 * Whether a failed expect run still captured a usable transcript.
 * Genuine timeouts (exit 2 + PTY_TIMEOUT_TAIL) stay fatal; everything else with
 * stdout is handed to the parser like main always did.
 */
export function shouldReturnPtyTranscript({ status, stdout = "", stderr = "", combined = "" } = {}) {
  const blob = combined || `${stdout}\n${stderr}`;
  if (/PTY_TIMEOUT_TAIL:/.test(blob) || status === 2) return false;
  if (stdout && isClosedSpawnExit(stderr)) return true;
  // Partial stdout on exit 3 is a boot failure, not a usable transcript.
  if (stdout && status === 1) return true;
  return false;
}

function cursorCommandBlock(seq) {
  const resultPat = shellEscape(seq.wait || "Esc to close");
  const acceptPat = shellEscape(seq.accept || "Show plan");
  const readyPat = shellEscape(seq.ready || "Tip:");
  return `expect {
  -re "${readyPat}" { }
${timeoutTail()}}
send "/"
expect {
  -re "${acceptPat}" { }
${timeoutTail()}}
send "usage"
expect {
  -re "${acceptPat}" { }
${timeoutTail()}}
send "\\r"
expect {
  -re "${resultPat}" { }
${timeoutTail()}}
`;
}

export function buildExpectScript(cli, timeoutSec = 45) {
  const seq = SEQUENCES[cli];
  if (!seq) throw new Error(`no PTY sequence for cli: ${cli}`);
  const cmd = shellEscape(seq.command);
  const exitCmd = shellEscape(seq.exit);
  const dialogs = dialogBranches();
  const bootTimeout = Math.max(45, Math.floor(timeoutSec * 0.6));

  if (cli === "codex") {
    const readyPat = shellEscape(seq.ready || "Tip:");
    const limitReadyPat = shellEscape(CODEX_LIMIT_READY_RE);
    const weeklyPat = shellEscape(CODEX_LIMIT_WAIT);
    const fiveHourPat = shellEscape(CODEX_LIMIT_WAIT_ALT);
    const waitHitPat = shellEscape(seq.waitHit || CODEX_HIT_LIMIT_WAIT);
    const panelTimeout = Math.max(60, Math.floor(timeoutSec * 0.35));
    const bootTimeout = Math.max(90, Math.floor(timeoutSec * 0.6));
    const statusBarPat = shellEscape(CODEX_STATUS_BAR_RE);
    return `set timeout ${bootTimeout}
match_max 1000000
spawn bash -c "${shellEscape(spawnLine(seq))}"
expect {
${dialogs}  -re "${readyPat}" { }
  eof { exit 3 }
${timeoutTail()}}
send "${cmd}\\r"
set timeout ${panelTimeout}
expect {
${dialogs}  -re "${weeklyPat}" { }
  -re "${fiveHourPat}" { }
  -re "${limitReadyPat}" { }
  -re "${waitHitPat}" { }
  -re "${statusBarPat}" { }
  timeout {
    send "${cmd}\\r"
    expect {
${dialogs}      -re "${weeklyPat}" { }
      -re "${fiveHourPat}" { }
      -re "${limitReadyPat}" { }
      -re "${waitHitPat}" { }
      -re "${statusBarPat}" { }
${timeoutTail()}    }
  }
}
${fastExitBlock(exitCmd)}`;
  }

  if (cli === "cursor") {
    const readyPat = shellEscape(seq.ready || "Tip:");
    return `set timeout ${bootTimeout}
match_max 1000000
spawn bash -c "${shellEscape(spawnLine(seq))}"
expect {
${dialogs}  -re "${readyPat}" { }
${timeoutTail()}}
${cursorCommandBlock(seq)}${fastExitBlock(exitCmd)}`;
  }

  const waitPat = shellEscape(seq.wait);
  return `set timeout ${timeoutSec}
spawn env O9K_USAGE_COLLECT=1 TERM=xterm-256color ${seq.bin}
expect {
${dialogs}  -re "${waitPat}" { }
${timeoutTail()}}
send "${cmd}\\r"
expect {
  -re "${waitPat}" { }
${timeoutTail()}}
${fastExitBlock(exitCmd)}`;
}

const PTY_MAX_BUFFER = 4 * 1024 * 1024;

/** pid (comm) state ppid pgrp — comm may contain spaces, so cut at the last ")". */
function readProcIds(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(rest[1]);
    const pgid = Number(rest[2]);
    return {
      ppid: Number.isFinite(ppid) ? ppid : 0,
      pgid: Number.isFinite(pgid) ? pgid : 0,
    };
  } catch {
    return null;
  }
}

function childPids(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    if (!text.trim()) return [];
    return text.trim().split(/\s+/).map(Number).filter((n) => n > 1);
  } catch {
    return [];
  }
}

/** expect's PTY child calls setsid, so it is not in expect's group. Walk the tree. */
function descendantRows(root) {
  const out = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    for (const child of childPids(pid)) {
      if (seen.has(child)) continue;
      seen.add(child);
      const ids = readProcIds(child);
      if (!ids) continue;
      out.push({ pid: child, pgid: ids.pgid });
      stack.push(child);
    }
  }
  return out;
}

function ancestorPgids(start) {
  const groups = new Set();
  const seen = new Set();
  let cur = start;
  while (cur > 1 && !seen.has(cur)) {
    seen.add(cur);
    const ids = readProcIds(cur);
    if (!ids) break;
    if (ids.pgid > 1) groups.add(ids.pgid);
    cur = ids.ppid;
  }
  return groups;
}

function publishTree(pidFile, recorded) {
  const body = [...recorded.entries()].map(([pid, pgid]) => `${pid} ${pgid}`).join("\n");
  const tmp = `${pidFile}.tmp`;
  fs.writeFileSync(tmp, body ? `${body}\n` : "");
  fs.renameSync(tmp, pidFile);
}

function readPublishedTree(pidFile) {
  let text = "";
  try {
    text = fs.readFileSync(pidFile, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split("\n")) {
    const [ps, gs] = line.trim().split(/\s+/);
    const pid = Number(ps);
    const pgid = Number(gs);
    if (pid > 1) entries.push({ pid, pgid: Number.isFinite(pgid) ? pgid : 0 });
  }
  return entries;
}

/** SIGKILL every recorded process group, then any pid the group signal missed. */
function signalTree(entries, skipPgids) {
  const groups = new Set();
  for (const { pgid } of entries) {
    if (pgid > 1 && !skipPgids.has(pgid)) groups.add(pgid);
  }
  for (const pgid of groups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const { pid } of entries) {
    if (pid <= 1) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function killPublishedTree(pidFile) {
  signalTree(readPublishedTree(pidFile), ancestorPgids(process.pid));
  for (const file of [pidFile, `${pidFile}.tmp`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

/**
 * expect in its own session, with a hard deadline. Dialog `exp_continue` restarts
 * expect's timer, so a prompt that never clears waits forever inside the script.
 * A SIGTERM to expect alone leaves the setsid PTY child and its grandchildren
 * (cursor-agent's typescript-language-server) alive; they inherit expect's stderr
 * socket. On the deadline, SIGKILL every descendant process group.
 */
function boundedExpectEntry() {
  const scriptPath = process.argv[3];
  const timeoutMs = Number(process.argv[4]);
  const pidFile = process.argv[5];
  if (!scriptPath || !pidFile || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write("bounded expect: bad arguments\n");
    process.exit(1);
  }

  const skipPgids = ancestorPgids(process.pid);
  const recorded = new Map();
  const child = spawn("expect", [scriptPath], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const outChunks = [];
  const errChunks = [];
  let outLen = 0;
  let errLen = 0;
  const take = (chunks, buf, len) => {
    if (len >= PTY_MAX_BUFFER) return len;
    chunks.push(buf);
    return len + buf.length;
  };
  child.stdout.on("data", (buf) => {
    outLen = take(outChunks, buf, outLen);
  });
  child.stderr.on("data", (buf) => {
    errLen = take(errChunks, buf, errLen);
  });
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});

  const snap = () => {
    if (!child.pid) return;
    const self = readProcIds(child.pid);
    if (self && self.pgid > 1 && !skipPgids.has(self.pgid)) recorded.set(child.pid, self.pgid);
    for (const row of descendantRows(child.pid)) {
      if (row.pgid > 1 && !skipPgids.has(row.pgid)) recorded.set(row.pid, row.pgid);
    }
    try {
      publishTree(pidFile, recorded);
    } catch {
      /* parent still has the previous snapshot */
    }
  };
  const kill = () => signalTree([...recorded.entries()].map(([pid, pgid]) => ({ pid, pgid })), skipPgids);

  snap();
  const iv = setInterval(snap, 50);
  let timedOut = false;
  let finished = false;
  const killer = setTimeout(() => {
    timedOut = true;
    snap();
    kill();
  }, timeoutMs);

  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearInterval(iv);
    clearTimeout(killer);
    snap();
    kill();
    const extra = timedOut ? "\nPTY_TIMEOUT_TAIL:\n(hard kill)\n" : "";
    const stdout = Buffer.concat(outChunks);
    const stderr = Buffer.concat([Buffer.concat(errChunks), Buffer.from(extra)]);
    process.stdout.write(stdout, () => {
      process.stderr.write(stderr, () => process.exit(code));
    });
    setTimeout(() => process.exit(code), 500);
  };

  child.on("error", (err) => {
    errChunks.push(Buffer.from(String(err?.message || err)));
    finish(1);
  });
  child.on("close", (code) => {
    finish(timedOut ? 2 : code === 0 ? 0 : (code ?? 1));
  });
}

function isBoundedExpectCli(argv) {
  if (argv[2] !== "--bounded-expect" || !argv[1]) return false;
  try {
    return path.resolve(argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function execExpectBounded(tmp, { timeoutMs, env, pidFile }) {
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--bounded-expect", tmp, String(timeoutMs), pidFile],
    {
      encoding: "utf8",
      env,
      timeout: timeoutMs + 5000,
      killSignal: "SIGKILL",
      maxBuffer: PTY_MAX_BUFFER,
    },
  );
  if (r.status === 0 && !r.error) return r.stdout || "";
  const err = r.error || new Error((r.stderr || r.stdout || `expect exited ${r.status}`).slice(0, 500));
  err.status = r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL" ? 2 : r.status;
  err.signal = r.signal;
  err.stdout = typeof r.stdout === "string" ? r.stdout : "";
  err.stderr = typeof r.stderr === "string" ? r.stderr : "";
  throw err;
}

/**
 * @param {'claude'|'codex'|'cursor'} cli
 * @param {{ timeoutSec?: number, hardTimeoutMs?: number, script?: string }} [opts]
 * @returns {string} transcript (stdout+stderr)
 */
export function runPtyCollect(cli, opts = {}) {
  const timeoutSec = opts.timeoutSec ?? (cli === "codex" || cli === "cursor" ? 180 : 45);
  const hardTimeoutMs = opts.hardTimeoutMs ?? (timeoutSec + 30) * 1000;
  const script = opts.script ?? buildExpectScript(cli, timeoutSec);
  const tmp = path.join(os.tmpdir(), `team-up-usage-pty-${cli}-${process.pid}.exp`);
  const pidFile = `${tmp}.tree`;
  fs.writeFileSync(tmp, script);
  try {
    // Strip collect markers from expect's environment — if the parent is already a
    // collector child, inherited TEAM_UP_USAGE_COLLECT makes codex refuse /status.
    const { TEAM_UP_USAGE_COLLECT, O9K_USAGE_COLLECT, ...parentEnv } = process.env;
    return execExpectBounded(tmp, {
      timeoutMs: hardTimeoutMs,
      env: { ...parentEnv, TERM: COLLECT_ENV.TERM },
      pidFile,
    });
  } catch (e) {
    const stdout = typeof e?.stdout === "string" ? e.stdout : e?.stdout?.toString?.("utf8") || "";
    const stderr = typeof e?.stderr === "string" ? e.stderr : e?.stderr?.toString?.("utf8") || "";
    const combined = `${stdout}\n${stderr}`;
    if (/PTY_TIMEOUT_TAIL:/.test(combined) || e?.status === 2) {
      throw new Error(formatPtyTimeoutError(cli, stdout, stderr));
    }
    if (
      shouldReturnPtyTranscript({
        status: e?.status,
        stdout,
        stderr,
        combined,
      })
    ) {
      return stdout;
    }
    const msg = String(e?.message || e);
    throw new Error(redactSecrets(msg));
  } finally {
    // Helper SIGKILLs the tree before it exits. This covers the parent backstop
    // (helper killed from outside) where that cleanup did not run.
    killPublishedTree(pidFile);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

if (isBoundedExpectCli(process.argv)) {
  boundedExpectEntry();
}

export {
  COLLECT_ENV,
  CODEX_LIMIT_WAIT,
  CODEX_LIMIT_WAIT_ALT,
  CODEX_HIT_LIMIT_WAIT,
  CODEX_LIMIT_READY_RE,
  CODEX_STATUS_BAR_RE,
  codexTrustFlag,
};
