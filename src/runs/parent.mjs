import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { atomicWriteJson } from "../json-store.mjs";
import { sessionsDir } from "../paths.mjs";
import { parseStat, readBootId } from "../telemetry/proc.mjs";

export const SESSION_SCHEMA = "team-up.session/v1";
const MAX_DEPTH = 16;

// Process names (as /proc/<pid>/comm shows them) of the CLIs that can be a
// parent. Only a guess at the CLI when nothing recorded the session itself.
export const CLI_PROCESS_NAMES = Object.freeze({
  claude: ["claude"],
  codex: ["codex"],
  opencode: ["opencode"],
  gemini: ["gemini"],
  cursor: ["cursor-agent", "agent"],
  hermes: ["hermes"],
});

// Env vars a CLI sets for its own child processes: the session id, and the
// CLI's pid where it exports one (docs/harness-session-identity.md). Claude
// Code's id can lag behind after `--continue`, which is why the registry the
// SessionStart hook writes is asked first.
//   tmux  whether $TMUX_PANE in a tool's env is the session's own pane.
//         Codex tools run under a shared daemon that kept the env it started
//         with, so its pane may be another session's.
//   cwd   "owner": the CLI process's cwd; "self": this process's cwd (the
//         tool's working directory), where the owner is a daemon.
export const SESSION_ENV = Object.freeze({
  claude: { session: "CLAUDE_CODE_SESSION_ID", pid: "CLAUDE_PID", tmux: true, cwd: "owner" },
  hermes: { session: "HERMES_SESSION_ID", pid: null, tmux: true, cwd: "owner" },
  codex: { session: "CODEX_SESSION_ID", pid: null, tmux: false, cwd: "self" },
  opencode: { session: "OPENCODE_SESSION_ID", pid: null, tmux: true, cwd: "self" },
});

function readStat(pid, procRoot) {
  try {
    return parseStat(fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8"));
  } catch {
    return null;
  }
}

function readCwd(pid, procRoot) {
  try {
    return fs.readlinkSync(path.join(procRoot, String(pid), "cwd"));
  } catch {
    return null;
  }
}

function cliForComm(comm) {
  for (const [cli, names] of Object.entries(CLI_PROCESS_NAMES)) {
    if (names.includes(comm)) return cli;
  }
  return null;
}

/** pid, then its parent, up to MAX_DEPTH or pid 1. */
export function ancestry(pid, { procRoot = "/proc" } = {}) {
  const out = [];
  let current = pid;
  for (let i = 0; i < MAX_DEPTH && current > 1; i++) {
    const stat = readStat(current, procRoot);
    if (!stat) break;
    out.push(stat);
    current = stat.ppid;
  }
  return out;
}

/**
 * The CLI process a hook belongs to. Hooks may run under `sh -c`, so the
 * nearest ancestor with a known CLI name wins; the direct parent otherwise.
 */
export function findCliProcess(startPid, { procRoot = "/proc", cli = null } = {}) {
  const chain = ancestry(startPid, { procRoot });
  const names = cli ? CLI_PROCESS_NAMES[cli] ?? [cli] : Object.values(CLI_PROCESS_NAMES).flat();
  return chain.find((p) => names.includes(p.comm)) ?? chain[0] ?? null;
}

export function sessionRecordPath(pid, { dir = sessionsDir() } = {}) {
  return path.join(dir, `${pid}.json`);
}

/** tmux session and pane of the calling process, or null outside tmux. */
export function currentTmux(env = process.env, { exec = execFileSync } = {}) {
  if (!env.TMUX || !env.TMUX_PANE) return null;
  try {
    const session = String(exec("tmux", ["display-message", "-p", "-t", env.TMUX_PANE, "#S"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    })).trim();
    return session ? { session, pane: env.TMUX_PANE } : null;
  } catch {
    return null;
  }
}

/**
 * Record the session a CLI process runs. Overwrites: a resumed or cleared
 * session keeps its pid and the newest id is the one that dispatches.
 */
export function writeSessionRecord({
  cli,
  sessionId,
  cwd,
  pid,
  tmux = null,
  source = null,
  procRoot = "/proc",
  dir = sessionsDir(),
  now = new Date(),
}) {
  const stat = readStat(pid, procRoot);
  const record = {
    schema: SESSION_SCHEMA,
    cli,
    session_id: sessionId,
    cwd: cwd ?? null,
    pid,
    pid_start: stat?.start_ticks ?? null,
    tmux,
    source,
    started_at: now.toISOString(),
    boot_id: readBootId(procRoot),
  };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteJson(sessionRecordPath(pid, { dir }), record);
  return record;
}

export function readSessionRecord(pid, { dir = sessionsDir() } = {}) {
  try {
    const record = JSON.parse(fs.readFileSync(sessionRecordPath(pid, { dir }), "utf8"));
    return record?.schema === SESSION_SCHEMA ? record : null;
  } catch {
    return null;
  }
}

/** A record still describes a live process: same boot, same pid start time. */
function recordIsLive(record, { procRoot, bootId }) {
  if (!record || record.boot_id !== bootId) return false;
  const stat = readStat(record.pid, procRoot);
  if (!stat) return false;
  return record.pid_start == null || stat.start_ticks == null || record.pid_start === stat.start_ticks;
}

/** Records whose process still runs in this boot: the live parent sessions. */
export function listLiveSessionRecords({ dir = sessionsDir(), procRoot = "/proc" } = {}) {
  const bootId = readBootId(procRoot);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => /^(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map((m) => readSessionRecord(Number(m[1]), { dir }))
    .filter((record) => recordIsLive(record, { procRoot, bootId }));
}

/** Remove records whose process is gone or from an earlier boot. */
export function pruneSessionRecords({ dir = sessionsDir(), procRoot = "/proc", dryRun = false } = {}) {
  const bootId = readBootId(procRoot);
  const removed = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const record = readSessionRecord(Number(m[1]), { dir });
    if (recordIsLive(record, { procRoot, bootId })) continue;
    removed.push(path.join(dir, name));
    if (!dryRun) fs.rmSync(path.join(dir, name), { force: true });
  }
  return removed;
}

function fromRecord(record, detectedBy) {
  const tmux = record.tmux?.session ?? null;
  return {
    cli: record.cli,
    sessionId: record.session_id ?? null,
    tmux,
    attach: tmux ? "tmux" : "manual",
    cwd: record.cwd ?? null,
    detected_by: detectedBy,
  };
}

/**
 * Which agent session is dispatching this run. Walks up from `pid` to the
 * first ancestor with a live registry record; then tries a CLI's session env
 * var; otherwise names the CLI it can see (or "manual") without a session id.
 * Never invents an id: a wrong id would resume the wrong conversation.
 */
export function detectParent({
  env = process.env,
  procRoot = "/proc",
  dir = sessionsDir(env),
  pid = process.pid,
  exec = execFileSync,
} = {}) {
  const bootId = readBootId(procRoot);
  const chain = ancestry(pid, { procRoot });
  for (const p of chain) {
    const record = readSessionRecord(p.pid, { dir });
    if (recordIsLive(record, { procRoot, bootId })) return fromRecord(record, "registry");
  }
  const guess = chain.map((p) => cliForComm(p.comm)).find(Boolean) ?? null;
  for (const [cli, vars] of Object.entries(SESSION_ENV)) {
    if (guess !== cli || !env[vars.session]) continue;
    // The variable must belong to a CLI process above us: a worker started
    // from a tmux server that inherited a parent's environment would carry
    // that parent's id otherwise.
    const owner = vars.pid && env[vars.pid]
      ? chain.find((p) => p.pid === Number(env[vars.pid]))
      : chain.find((p) => CLI_PROCESS_NAMES[cli].includes(p.comm));
    if (!owner) continue;
    const tmux = vars.tmux ? currentTmux(env, { exec }) : null;
    return {
      cli,
      sessionId: env[vars.session],
      tmux: tmux?.session ?? null,
      attach: tmux ? "tmux" : "manual",
      cwd: vars.cwd === "owner" ? readCwd(owner.pid, procRoot) : readCwd(pid, procRoot),
      detected_by: "env",
    };
  }
  return { cli: guess ?? "manual", sessionId: null, tmux: null, attach: "manual", cwd: null, detected_by: "none" };
}
