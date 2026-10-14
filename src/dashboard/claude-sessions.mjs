// Claude Code sessions that run outside tmux — the desktop app's chats above
// all — are invisible to `tmux list-sessions`. Claude Code keeps its own
// registry of live sessions in ~/.claude/sessions/<pid>.json, and every
// session listens on a local socket for messages from other sessions. Both are
// undocumented and read here as found in Claude Code 2.1.29x.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";

export const MAX_MESSAGE_CHARS = 4000;

export function claudeSessionsDir(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
  return path.join(configDir, "sessions");
}

/**
 * Field 22 of /proc/<pid>/stat, the start time in clock ticks. Claude Code
 * records the same value as `procStart`, so a pid the kernel has since handed
 * to another process never matches.
 */
function procStart(pid, procRoot) {
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    // The command name (field 2) may hold spaces and parens: count from its end.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** Live sessions only: a registry file outlives a crashed session. */
export function listClaudeSessions({ env = process.env, procRoot = "/proc" } = {}) {
  const dir = claudeSessionsDir(env);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const sessions = [];
  for (const file of files) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (!Number.isInteger(s?.pid) || `${s.pid}.json` !== file) continue;
    if (!s.procStart || procStart(s.pid, procRoot) !== String(s.procStart)) continue;
    sessions.push({
      pid: s.pid,
      sessionId: s.sessionId ?? null,
      name: s.name ?? null,
      status: s.status ?? null,
      cwd: s.cwd ?? null,
      entrypoint: s.entrypoint ?? null,
      // "moonlight:@1.%1" → the tmux session the Terminals table already shows.
      tmux: typeof s.tmux === "string" ? s.tmux.split(":")[0] : null,
      startedAt: s.startedAt ?? null,
      updatedAt: s.updatedAt ?? null,
      version: s.version ?? null,
      socket: s.peerProtocol === 1 && s.messagingSocketPath ? s.messagingSocketPath : null,
    });
  }
  return sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function findLive(pid, opts) {
  return listClaudeSessions(opts).find((s) => s.pid === pid) ?? null;
}

/**
 * SIGTERM, as on a closed terminal. The transcript stays: the desktop app
 * starts the session again on its next message, `claude --resume` works too.
 */
export function stopClaudeSession(pid, { kill = process.kill, ...opts } = {}) {
  const session = findLive(pid, opts);
  if (!session) return { ok: false, status: 404, error: "session not found" };
  kill(pid, "SIGTERM");
  return { ok: true, session };
}

/**
 * Queue `text` in the session as a message from another session — the same
 * channel Claude's SendMessage tool uses. The receiving model reads it as a
 * peer's note, not as its user typing: it may decline an instruction in it.
 */
export async function sendClaudeMessage(pid, text, { connect = net.createConnection, timeoutMs = 3000, ...opts } = {}) {
  const session = findLive(pid, opts);
  if (!session) return { ok: false, status: 404, error: "session not found" };
  if (!session.socket) return { ok: false, status: 409, error: "session has no message inbox" };
  // The token file is named after the socket path it unlocks.
  const hash = crypto.createHash("sha256").update(session.socket).digest("hex");
  let token;
  try {
    token = JSON.parse(fs.readFileSync(path.join(claudeSessionsDir(opts.env), `${pid}.${hash}.key`), "utf8")).peerToken;
  } catch {
    return { ok: false, status: 409, error: "session inbox key not readable" };
  }
  const frames = `${JSON.stringify({ type: "auth", token })}\n${JSON.stringify({
    type: "user",
    from: "team-up dashboard",
    priority: "next",
    message: { content: text },
  })}\n`;
  try {
    await new Promise((resolve, reject) => {
      const sock = connect(session.socket);
      sock.setTimeout(timeoutMs, () => sock.destroy(new Error("inbox did not answer")));
      sock.on("error", reject);
      sock.on("connect", () => sock.end(frames));
      sock.on("close", resolve);
    });
  } catch (e) {
    return { ok: false, status: 502, error: String(e.message || e) };
  }
  return { ok: true, session };
}
