// usage-pty.mjs — expect-based interactive slash-command collector (codex/cursor; claude fallback).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

/**
 * @param {'claude'|'codex'|'cursor'} cli
 * @param {{ timeoutSec?: number }} [opts]
 * @returns {string} transcript (stdout+stderr)
 */
export function runPtyCollect(cli, opts = {}) {
  const timeoutSec = opts.timeoutSec ?? (cli === "codex" || cli === "cursor" ? 180 : 45);
  const script = buildExpectScript(cli, timeoutSec);
  const tmp = path.join(os.tmpdir(), `team-up-usage-pty-${cli}-${process.pid}.exp`);
  fs.writeFileSync(tmp, script);
  try {
    // Strip collect markers from expect's environment — if the parent is already a
    // collector child, inherited TEAM_UP_USAGE_COLLECT makes codex refuse /status.
    const { TEAM_UP_USAGE_COLLECT, O9K_USAGE_COLLECT, ...parentEnv } = process.env;
    return execFileSync("expect", [tmp], {
      encoding: "utf8",
      env: { ...parentEnv, TERM: COLLECT_ENV.TERM },
      timeout: (timeoutSec + 30) * 1000,
      maxBuffer: 4 * 1024 * 1024,
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
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
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
