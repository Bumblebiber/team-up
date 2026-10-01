import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "../json-store.mjs";
import { sessionsDir } from "../paths.mjs";

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function pendingDir(env = process.env) {
  return path.join(sessionsDir(env), "pending");
}

function pendingPath(sessionId, env) {
  if (!SESSION_ID.test(String(sessionId ?? ""))) throw new Error(`invalid session id: ${sessionId}`);
  return path.join(pendingDir(env), `${sessionId}.md`);
}

/**
 * Leave a wake-up message for a session team-up cannot restart itself (not
 * in tmux). The SessionStart hook hands it over when that session next
 * starts or resumes. A newer message for the same session replaces the old.
 */
export function writePendingWakeup(sessionId, text, { env = process.env } = {}) {
  const file = pendingPath(sessionId, env);
  atomicWriteText(file, text, { mode: 0o600 });
  return file;
}

/** The pending message for `sessionId`, moved to delivered/; null if none. */
export function takePendingWakeup(sessionId, { env = process.env, now = new Date() } = {}) {
  let file;
  try {
    file = pendingPath(sessionId, env);
  } catch {
    return null;
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const delivered = path.join(sessionsDir(env), "delivered");
  fs.mkdirSync(delivered, { recursive: true, mode: 0o700 });
  fs.renameSync(file, path.join(delivered, `${sessionId}-${now.toISOString().replace(/[:.]/g, "-")}.md`));
  return text;
}
