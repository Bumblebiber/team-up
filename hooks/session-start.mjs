#!/usr/bin/env node
// Claude Code SessionStart hook: records which session runs in which process
// so a run dispatched from it can name its parent, and hands over a wake-up
// message left for this session while it could not be reached.
// It must never block or fail a session: every error is swallowed and logged.
import fs from "node:fs";
import path from "node:path";
import { debugLogDir, sessionsDir } from "../src/paths.mjs";
import { CLI_PROCESS_NAMES, currentTmux, findCliProcess, writeSessionRecord } from "../src/runs/parent.mjs";
import { takePendingWakeup } from "../src/runs/pending.mjs";

function log(env, message) {
  try {
    const dir = debugLogDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "hooks.log"), `${new Date().toISOString()} session-start ${message}\n`);
  } catch {
    // nowhere left to report
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function runSessionStart({ input, env = process.env, ppid = process.ppid, procRoot = "/proc", exec } = {}) {
  const event = JSON.parse(input || "{}");
  if (!event.session_id) throw new Error("hook input has no session_id");
  // The Cursor CLI runs Claude Code hooks too (on by default). Its chat is not
  // a Claude session: record it as Cursor, only where its process is found.
  if (event.cursor_version || env.CURSOR_VERSION) {
    const cursor = findCliProcess(ppid, { procRoot, cli: "cursor" });
    if (!cursor || !CLI_PROCESS_NAMES.cursor.includes(cursor.comm)) return null;
    writeSessionRecord({
      cli: "cursor",
      sessionId: event.session_id,
      cwd: event.workspace_roots?.[0] ?? env.CURSOR_PROJECT_DIR ?? null,
      pid: cursor.pid,
      tmux: currentTmux(env, exec ? { exec } : undefined),
      source: event.hook_event_name ?? null,
      procRoot,
      dir: sessionsDir(env),
    });
    return null;
  }
  // CLAUDE_PID names the CLI directly; without it, walk up past `sh -c`.
  const exported = Number(env.CLAUDE_PID);
  const cli = Number.isInteger(exported) && exported > 1
    ? { pid: exported }
    : findCliProcess(ppid, { procRoot, cli: "claude" });
  writeSessionRecord({
    cli: "claude",
    sessionId: event.session_id,
    cwd: event.cwd ?? null,
    pid: cli?.pid ?? ppid,
    tmux: currentTmux(env, exec ? { exec } : undefined),
    source: event.source ?? null,
    procRoot,
    dir: sessionsDir(env),
  });
  const message = takePendingWakeup(event.session_id, { env });
  if (!message) return null;
  return {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  // Synchronous throughout; the one external call (tmux) has a 500 ms timeout
  // and hooks.json caps the whole hook, so a stuck step cannot hold a session.
  try {
    const out = runSessionStart({ input: readStdin() });
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (error) {
    log(process.env, `error: ${error.message}`);
  }
  process.exit(0);
}
