// usage-procs.mjs — precise agent process counting (excludes collectors + MCP noise).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { usageWatcherStatePath } from "../paths.mjs";

export const CLI_BINARIES = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor-agent",
};

function readProcEnviron(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, "utf8");
  } catch {
    return "";
  }
}

export function procHasEnvMarker(pid, envMarker = "O9K_USAGE_COLLECT") {
  return readProcEnviron(pid).includes(`${envMarker}=1`);
}

/** @returns {boolean} */
export function isCollectorCmdline(cmdline, envMarker = "O9K_USAGE_COLLECT") {
  if (!cmdline) return false;
  if (cmdline.includes(`${envMarker}=1`)) return true;
  if (/\bclaude\b.*\s-p\s+.*\/usage/.test(cmdline)) return true;
  if (cmdline.includes("usage-collect.mjs")) return true;
  if (cmdline.includes("usage-pty.mjs")) return true;
  if (cmdline.includes("usage-watcher.mjs")) return true;
  return false;
}

/** @returns {boolean} */
export function isAgentProcessCmdline(cmdline, cli, envMarker = "O9K_USAGE_COLLECT") {
  if (!cmdline || isCollectorCmdline(cmdline, envMarker)) return false;
  if (!CLI_BINARIES[cli]) return false;
  if (cli === "claude") {
    if (/mcp-server|@modelcontextprotocol/i.test(cmdline)) return false;
    if (/(?:^|\/)claude(?:\s|$)/.test(cmdline)) return true;
    // node-launched claude CLI bundles
    return /\bnode\b/.test(cmdline) && /\bclaude\b/i.test(cmdline) && !/mcp-server/i.test(cmdline);
  }
  if (cli === "codex") return /(?:^|\/)codex(?:\s|$)/.test(cmdline);
  if (cli === "cursor") return /(?:^|\/)cursor-agent(?:\s|$)/.test(cmdline);
  return false;
}

/** ppid from /proc/<pid>/stat (comm can hold spaces, so scan past the last ")"). */
export function readProcPpid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/** This process and every ancestor — the pids a sweep must never signal. */
export function ancestorPids(pid = process.pid, readPpid = readProcPpid) {
  const chain = new Set();
  let cur = pid;
  while (cur > 0 && !chain.has(cur)) {
    chain.add(cur);
    cur = readPpid(cur) || 0;
  }
  return chain;
}

/**
 * Processes a collect left behind. The collect env marker is inherited by the
 * whole tree — the CLI, its MCP servers (the telegram plugin's `bun`), their
 * children — so anything still carrying it once the collect returned outlived
 * it. Self + ancestors are excluded: without that, a collect started from a
 * shell that exported the marker would kill the watcher, or systemd.
 *
 * ponytail: env marker, not process group — a detached MCP server escapes the
 * group but not its environment. Blind spot: an unrelated session launched
 * from a shell where the marker leaked is not an ancestor and would be swept.
 */
export function collectStrayPids({
  envMarker = "O9K_USAGE_COLLECT",
  listPids = listProcPids,
  hasEnvMarker = procHasEnvMarker,
  keepPids,
} = {}) {
  const keep = keepPids ? new Set(keepPids) : ancestorPids();
  return listPids().filter((pid) => !keep.has(pid) && hasEnvMarker(pid, envMarker));
}

/** SIGKILL every stray (they are already orphaned; nothing to flush). */
export function killCollectStrays(opts = {}) {
  const pids = collectStrayPids(opts);
  const kill = opts.kill || ((pid) => process.kill(pid, "SIGKILL"));
  for (const pid of pids) {
    try {
      kill(pid);
    } catch {
      /* already gone */
    }
  }
  return pids;
}

function readProcCmdline(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return raw.replaceAll("\0", " ").trim();
  } catch {
    return null;
  }
}

function listProcPids() {
  try {
    return fs
      .readdirSync("/proc")
      .filter((n) => /^\d+$/.test(n))
      .map((n) => Number(n));
  } catch {
    return [];
  }
}

/** Parse `ps -axo pid=,command=` output into a pid→cmdline map. Exported for tests. */
export function parsePsTable(text) {
  const table = new Map();
  for (const line of String(text || "").split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) table.set(Number(m[1]), m[2].trim());
  }
  return table;
}

/** macOS/BSD fallback: one ps call instead of /proc walks. */
function psProcessTable() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10_000,
    });
    return parsePsTable(out);
  } catch {
    return new Map();
  }
}

const HAS_PROC = fs.existsSync("/proc");

/**
 * JSON fixture path from TEAM_UP_AGENT_PROCS_FIXTURE / O9K_AGENT_PROCS_FIXTURE.
 * File shape: { "123": "/usr/bin/claude ...", ... } or { cmdlines: { ... } }.
 */
export function agentProcsFixtureFromEnv(env = process.env) {
  const p = env.TEAM_UP_AGENT_PROCS_FIXTURE || env.O9K_AGENT_PROCS_FIXTURE;
  if (!p) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const map = raw?.cmdlines || raw;
    if (!map || typeof map !== "object" || Array.isArray(map)) return null;
    return map;
  } catch {
    return null;
  }
}

/** Build countAgentProcesses opts from env fixture (empty object when unset). */
export function countAgentProcessesOptsFromEnv(env = process.env) {
  const map = agentProcsFixtureFromEnv(env);
  if (!map) return {};
  const pids = Object.keys(map)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n));
  return {
    listPids: () => pids,
    readCmdline: (pid) => map[String(pid)] ?? map[pid] ?? null,
    hasEnvMarker: () => false,
  };
}

/**
 * Count live agent processes per subscription CLI.
 * @param {{ excludePids?: number[], envMarker?: string, listPids?: () => number[], readCmdline?: (pid: number) => string|null, hasEnvMarker?: (pid: number, marker: string) => boolean }} [opts]
 */
export function countAgentProcesses(opts = {}) {
  const envMarker = opts.envMarker || "O9K_USAGE_COLLECT";
  const exclude = new Set(opts.excludePids || []);
  let { listPids, readCmdline, hasEnvMarker } = opts;
  if (!listPids && !readCmdline) {
    const envFixture = countAgentProcessesOptsFromEnv();
    if (envFixture.listPids) {
      ({ listPids, readCmdline, hasEnvMarker } = envFixture);
    } else if (HAS_PROC) {
      listPids = listProcPids;
      readCmdline = readProcCmdline;
    } else {
      // No /proc (macOS/BSD): one ps snapshot. Env markers aren't readable
      // there, but collector spawns carry O9K_USAGE_COLLECT=1 in the cmdline
      // (usage-pty.mjs spawns via `env`), so isCollectorCmdline still catches them.
      const table = psProcessTable();
      listPids = () => [...table.keys()];
      readCmdline = (pid) => table.get(pid) ?? null;
      hasEnvMarker = hasEnvMarker || (() => false);
    }
  }
  listPids = listPids || listProcPids;
  readCmdline = readCmdline || readProcCmdline;
  hasEnvMarker = hasEnvMarker || procHasEnvMarker;

  const counts = { claude: 0, codex: 0, cursor: 0 };
  for (const pid of listPids()) {
    if (exclude.has(pid)) continue;
    if (hasEnvMarker(pid, envMarker)) continue;
    const cmdline = readCmdline(pid);
    if (!cmdline) continue;
    for (const cli of Object.keys(CLI_BINARIES)) {
      if (isAgentProcessCmdline(cmdline, cli, envMarker)) counts[cli]++;
    }
  }
  return counts;
}

// Same rule as the PTY lock: TEAM_UP_HOME decides, so isolated runs get an
// isolated watcher state file.
export function watcherStatePath() {
  return usageWatcherStatePath();
}
