// pty-expect-core.mjs — shared expect-script fragments for usage and model PTY collectors.

import os from "node:os";

export function shellEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function bashSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function homeDir() {
  return process.env.HOME || os.homedir();
}

export function codexTrustFlag(home) {
  return `projects={${JSON.stringify(home)}={trust_level="trusted"}}`;
}

/**
 * @param {{ bin: string, cols?: number, rows?: number }} seq
 */
export function spawnLine(seq) {
  const cols = seq.cols ?? 120;
  const rows = seq.rows ?? 40;
  const home = shellEscape(homeDir());
  const env =
    `O9K_USAGE_COLLECT=1 TEAM_UP_USAGE_COLLECT=1 TERM=xterm-256color COLUMNS=${cols} LINES=${rows}`;
  if (seq.bin === "codex") {
    return (
      `stty cols ${cols} rows ${rows} 2>/dev/null; cd ${bashSingleQuote(homeDir())} && ` +
      `exec env O9K_USAGE_COLLECT=1 TERM=xterm-256color ` +
      `${seq.bin} -c ${bashSingleQuote(codexTrustFlag(homeDir()))} ` +
      `-c ${bashSingleQuote("check_for_update_on_startup=false")}`
    );
  }
  // Cursor's trust dialog wants a menu choice, not the codex answer the shared
  // branch types, so it never clears and the probe runs into its deadline.
  if (seq.bin === "cursor-agent") {
    return `stty cols ${cols} rows ${rows} 2>/dev/null; cd ${home} && exec env ${env} ${seq.bin} --trust`;
  }
  if (seq.bin === "claude") {
    return `stty cols ${cols} rows ${rows} 2>/dev/null; cd ${bashSingleQuote(homeDir())} && exec env O9K_USAGE_COLLECT=1 TERM=xterm-256color ${seq.bin}`;
  }
  return `stty cols ${cols} rows ${rows} 2>/dev/null; cd ${home} && exec env ${env} ${seq.bin}`;
}

/** Shared dialog branches — never pick update menu option 1 (self-update). */
export function dialogBranches(extra = "") {
  return `  -re "Update available" { sleep 0.5; send "\\033"; exp_continue }
  -re "Continue anyway" { send "y\\r"; exp_continue }
  -re "Do you trust the contents of this directory" { send "Yes, continue\\r"; exp_continue }
${extra}`;
}

/** Claude workspace trust — Down to "Yes, I trust", Enter to confirm. */
export function claudeTrustBranch() {
  return `  -re "Quick safety check" { sleep 0.5; send "\\033\\[B"; sleep 0.3; send "\\r"; exp_continue }
`;
}

/** After data is captured: exit quickly instead of waiting for graceful eof. */
export function fastExitBlock(exitCmd) {
  const cmd = shellEscape(exitCmd);
  return `catch { send "${cmd}\\r" }
set timeout 3
catch {
  expect {
    eof { }
    timeout { }
  }
}
catch { close }
exit 0
`;
}

export function timeoutTail() {
  return `  timeout {
    set _buf ""
    catch { set _buf $expect_out(buffer) }
    set _lines [split $_buf "\\n"]
    set _n [llength $_lines]
    set _start [expr {$_n > 15 ? $_n - 15 : 0}]
    set _tail [join [lrange $_lines $_start end] "\\n"]
    puts stderr "PTY_TIMEOUT_TAIL:\\n$_tail"
    exit 2
  }
`;
}
