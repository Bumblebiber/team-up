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
  cursor: { bin: "cursor-agent", command: "/usage", wait: "Included", exit: "/exit" },
};

function shellEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function codexSpawnLine(seq) {
  const cols = seq.cols ?? 120;
  const rows = seq.rows ?? 40;
  const cwd = shellEscape(process.env.HOME || os.homedir());
  return `stty cols ${cols} rows ${rows} 2>/dev/null; cd ${cwd} && exec env O9K_USAGE_COLLECT=1 TEAM_UP_USAGE_COLLECT=1 TERM=xterm-256color COLUMNS=${cols} LINES=${rows} ${seq.bin}`;
}

export function buildExpectScript(cli, timeoutSec = 45) {
  const seq = SEQUENCES[cli];
  if (!seq) throw new Error(`no PTY sequence for cli: ${cli}`);
  const cmd = shellEscape(seq.command);
  const exitCmd = shellEscape(seq.exit);
  if (cli === "codex") {
    const bootTimeout = Math.max(90, Math.floor(timeoutSec * 0.6));
    const readyPat = shellEscape(seq.ready || "Tip:");
    const statusWaitSec = Math.max(20, Math.floor(timeoutSec * 0.15));
    return `set timeout ${bootTimeout}
match_max 1000000
spawn bash -c "${shellEscape(codexSpawnLine(seq))}"
expect {
  -re "Continue anyway" { send "y\\r"; exp_continue }
  -re "${readyPat}" { }
  timeout { exit 2 }
}
sleep 3
send "${cmd}\\r"
sleep ${statusWaitSec}
send "${exitCmd}\\r"
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
  const timeoutSec = opts.timeoutSec ?? (cli === "codex" ? 180 : 45);
  const script = buildExpectScript(cli, timeoutSec);
  const tmp = path.join(os.tmpdir(), `o9k-usage-pty-${cli}-${process.pid}.exp`);
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
