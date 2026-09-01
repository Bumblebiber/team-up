// usage-pty.mjs — expect-based interactive slash-command collector (codex/cursor; claude fallback).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const COLLECT_ENV = { O9K_USAGE_COLLECT: "1", TEAM_UP_USAGE_COLLECT: "1", TERM: "xterm-256color" };

const SEQUENCES = {
  claude: { bin: "claude", command: "/usage", wait: "Current session", exit: "/exit" },
  codex: {
    bin: "codex",
    command: "/status",
    ready: "Tip:",
    exit: "/exit",
    cols: 120,
    rows: 40,
  },
  cursor: {
    bin: "cursor-agent",
    command: "/usage",
    ready: "Tip:",
    accept: "Show plan",
    wait: "Included",
    exit: "/exit",
    cols: 120,
    rows: 40,
  },
};

function shellEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function spawnLine(seq) {
  const cols = seq.cols ?? 120;
  const rows = seq.rows ?? 40;
  const cwd = shellEscape(process.env.HOME || os.homedir());
  return `stty cols ${cols} rows ${rows} 2>/dev/null; cd ${cwd} && exec env O9K_USAGE_COLLECT=1 TEAM_UP_USAGE_COLLECT=1 TERM=xterm-256color COLUMNS=${cols} LINES=${rows} ${seq.bin}`;
}

function cursorCommandBlock(seq, resultWaitSec) {
  const resultPat = shellEscape(seq.wait || "Included");
  const acceptPat = shellEscape(seq.accept || "Show plan");
  // cursor-agent slash autocomplete needs / then usage separately; a single
  // "/usage\\r" opens the menu but Enter fires before accept is ready.
  return `sleep 3
send "/"
sleep 0.5
send "usage"
expect {
  -re "${acceptPat}" { }
  timeout { exit 2 }
}
sleep 1
send "\\r"
sleep ${resultWaitSec}
expect {
  -re "${resultPat}" { }
  timeout { exit 2 }
}
`;
}

export function buildExpectScript(cli, timeoutSec = 45) {
  const seq = SEQUENCES[cli];
  if (!seq) throw new Error(`no PTY sequence for cli: ${cli}`);
  const cmd = shellEscape(seq.command);
  const exitCmd = shellEscape(seq.exit);
  if (cli === "codex") {
    const bootTimeout = Math.max(90, Math.floor(timeoutSec * 0.6));
    const readyPat = shellEscape(seq.ready || "Tip:");
    const resultWaitSec = Math.max(20, Math.floor(timeoutSec * 0.15));
    return `set timeout ${bootTimeout}
match_max 1000000
spawn bash -c "${shellEscape(spawnLine(seq))}"
expect {
  -re "Continue anyway" { send "y\\r"; exp_continue }
  -re "${readyPat}" { }
  timeout { exit 2 }
}
sleep 3
send "${cmd}\\r"
sleep ${resultWaitSec}
send "${exitCmd}\\r"
expect eof
`;
  }
  if (cli === "cursor") {
    const bootTimeout = Math.max(90, Math.floor(timeoutSec * 0.6));
    const readyPat = shellEscape(seq.ready || "Tip:");
    const resultWaitSec = Math.max(30, Math.floor(timeoutSec * 0.2));
    return `set timeout ${bootTimeout}
match_max 1000000
spawn bash -c "${shellEscape(spawnLine(seq))}"
expect {
  -re "Continue anyway" { send "y\\r"; exp_continue }
  -re "${readyPat}" { }
  timeout { exit 2 }
}
${cursorCommandBlock(seq, resultWaitSec)}send "${exitCmd}\\r"
expect eof
`;
  }
  const waitPat = shellEscape(seq.wait);
  return `set timeout ${timeoutSec}
spawn env O9K_USAGE_COLLECT=1 TERM=xterm-256color ${seq.bin}
expect {
  -re "Continue anyway" { send "y\\r"; exp_continue }
  -re "${waitPat}" { }
  timeout { exit 2 }
}
sleep 1
send "${cmd}\\r"
expect {
  -re "${waitPat}" { }
  timeout { }
}
sleep 1
send "${exitCmd}\\r"
expect eof
`;
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
    return execFileSync("expect", [tmp], {
      encoding: "utf8",
      env: { ...process.env, ...COLLECT_ENV },
      timeout: (timeoutSec + 60) * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export { COLLECT_ENV };
