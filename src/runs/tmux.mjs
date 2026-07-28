import { execFileSync } from "node:child_process";

export function inspectTmuxSession(session, { exec = execFileSync } = {}) {
  if (!session) return { exists: false, activityMs: null, sessionId: null };
  try {
    const raw = exec(
      "tmux",
      ["display-message", "-p", "-t", session, "#{window_activity} #{session_id}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const [activityRaw, sessionId] = raw.split(/\s+/, 2);
    const seconds = Number(activityRaw);
    return {
      exists: true,
      activityMs: Number.isFinite(seconds) ? seconds * 1000 : null,
      sessionId: sessionId || null,
    };
  } catch {
    return { exists: false, activityMs: null, sessionId: null };
  }
}

export function stopTmuxSession(session, { exec = execFileSync } = {}) {
  if (!session) return false;
  try {
    exec("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function tmuxSessionExists(sessionId, { exec = execFileSync } = {}) {
  if (!sessionId) return false;
  try {
    exec("tmux", ["has-session", "-t", sessionId], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
