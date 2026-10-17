import { execFileSync } from "node:child_process";

/**
 * tmux resolves a bare `-t name` by prefix: a gone "x-abc" silently addressed a
 * live "x-abcdef" (measured, tmux 3.4). "=" makes the match exact; the trailing
 * ":" makes it a pane target (the session's current pane) for pane commands.
 */
export const paneTarget = (session) => `=${session}:`;

/** Pane text; "" for an empty pane, null when the session is gone. */
export function tmuxCapture(session, { args = ["-p"], exec = execFileSync } = {}) {
  if (!session) return null;
  try {
    return String(exec("tmux", ["capture-pane", "-t", paneTarget(session), ...args], { encoding: "utf8" }));
  } catch {
    return null;
  }
}

/** Send each key in turn; false (and nothing typed) when the session is gone. */
export function tmuxSendKeys(session, keys, { literal = false, exec = execFileSync } = {}) {
  if (!session) return false;
  try {
    for (const key of keys) {
      exec("tmux", ["send-keys", "-t", paneTarget(session), ...(literal ? ["-l"] : []), key], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

export function inspectTmuxSession(session, { exec = execFileSync } = {}) {
  if (!session) return { exists: false, activityMs: null, sessionId: null, attached: false };
  try {
    const raw = exec(
      "tmux",
      ["display-message", "-p", "-t", paneTarget(session), "#{window_activity} #{session_id} #{session_attached}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    // `display-message -t` exits 0 for a session that does not exist and simply
    // prints nothing, so a thrown error is not the only way to be absent — only
    // `has-session` reports it as a failure. Treating empty output as "exists"
    // told the collector to kill a terminal that was already gone, which then
    // could not be marked cleaned, so the same runs came back every five
    // minutes forever.
    if (!raw) return { exists: false, activityMs: null, sessionId: null, attached: false };
    const parts = raw.split(/\s+/);
    const seconds = Number(parts[0]);
    const sessionId = parts[1] || null;
    const attached = parts[2] === "1";
    return {
      exists: true,
      activityMs: Number.isFinite(seconds) ? seconds * 1000 : null,
      sessionId,
      attached,
    };
  } catch {
    return { exists: false, activityMs: null, sessionId: null, attached: false };
  }
}

export function stopTmuxSession(session, { exec = execFileSync } = {}) {
  if (!session) return false;
  try {
    // "=" = exact name. Without it tmux falls back to a prefix match: killing
    // a gone "x-ab" took the live "x-abc" with it (measured, tmux 3.4).
    exec("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function tmuxSessionExists(sessionId, { exec = execFileSync } = {}) {
  if (!sessionId) return false;
  try {
    exec("tmux", ["has-session", "-t", `=${sessionId}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Names of every live tmux session, or an empty list when tmux itself is
 * absent or has no server running. An empty list is the same answer as "no
 * sessions", which is what a caller asking about orphans needs.
 */
export function listTmuxSessions({ exec = execFileSync } = {}) {
  try {
    const raw = exec("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(raw).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
