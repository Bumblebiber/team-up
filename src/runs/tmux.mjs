import { execFileSync } from "node:child_process";

export function inspectTmuxSession(session, { exec = execFileSync } = {}) {
  if (!session) return { exists: false, activityMs: null };
  try {
    const raw = exec(
      "tmux",
      ["display-message", "-p", "-t", session, "#{window_activity}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const seconds = Number(raw);
    return {
      exists: true,
      activityMs: Number.isFinite(seconds) ? seconds * 1000 : null,
    };
  } catch {
    return { exists: false, activityMs: null };
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
