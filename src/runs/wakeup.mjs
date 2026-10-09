import path from "node:path";
import { atomicWriteText } from "../json-store.mjs";

export const WATCH_CEILING_SEC = 7200;
// CLIs team-up can restart by session id, and those whose SessionStart hook
// picks up a pending message (docs/harness-session-identity.md).
export const RESUMABLE_CLIS = new Set(["claude", "codex", "hermes", "cursor", "agy"]);
export const PENDING_CLIS = new Set(["claude"]);
const MAX_LISTED = 10;
const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** One key per parent session: its id if known, else its tmux name. */
export function parentKey(parent) {
  if (!parent) return null;
  if (parent.sessionId) return `${parent.cli}:${parent.sessionId}`;
  if (parent.attach === "tmux" && parent.tmux) return `tmux:${parent.tmux}`;
  return null;
}

/**
 * How a parent hears about the resume:
 *   spawn    its tmux is gone and its session id is known: restart it there
 *   alive    its tmux still exists: left alone, a live session is not pasted into
 *   pending  it ran outside tmux: the message waits for its next session start
 *   none     nothing identifies it, or its CLI cannot be resumed by id: the
 *            human reads `runs resume` output
 */
export function parentDelivery(parent, { tmuxExists }) {
  if (parent?.attach === "tmux" && parent.tmux) {
    if (tmuxExists(parent.tmux)) return "alive";
    return parent.sessionId && RESUMABLE_CLIS.has(parent.cli) ? "spawn" : "none";
  }
  return parent?.sessionId && PENDING_CLIS.has(parent.cli) ? "pending" : "none";
}

/**
 * Active runs grouped by the session that dispatched them, so a parent with
 * three runs in flight comes back once, not three times. The newest run's
 * parent record wins: a session resumed in another tmux carries the new name.
 */
export function buildParentPlan(states, { tmuxExists, uncollected = [] } = {}) {
  const groups = new Map();
  const ordered = [...states].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const state of ordered) {
    if (TERMINAL.has(state.status)) continue;
    const key = parentKey(state.parent);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, parent: state.parent, runIds: [], uncollected: [] });
    const group = groups.get(key);
    group.parent = state.parent;
    group.runIds.push(state.runId);
  }
  for (const item of uncollected) {
    const group = groups.get(parentKey(item.parent));
    if (group) group.uncollected.push(item.runId);
  }
  return [...groups.values()].map((group) => ({ ...group, delivery: parentDelivery(group.parent, { tmuxExists }) }));
}

/**
 * argv that restarts a parent session, and whether the message still has to
 * be pasted. Every CLI here takes it on the command line, which avoids racing
 * the TUI's startup; `paste` stays for a CLI that cannot.
 * OpenCode and the older Gemini CLI are left out: OpenCode 1.x ignores
 * --prompt with -s and 2.x continues interrupted turns on its own; Gemini has
 * no session detection yet. Antigravity CLI resumes by conversation id below.
 */
export function parentResumeArgv({ cli, sessionId }, message, cwd = null) {
  if (cli === "claude") return { argv: ["claude", "--resume", sessionId, message], paste: false };
  // -C answers the "which directory" picker Codex shows when cwd differs.
  if (cli === "codex") {
    return { argv: ["codex", "resume", sessionId, ...(cwd ? ["-C", cwd] : []), message], paste: false };
  }
  // On a terminal `-q` seeds the first turn and the REPL stays open; Hermes
  // restores the session's cwd itself.
  // Cursor keeps chats per cwd: the pane must start in the parent's own cwd.
  if (cli === "cursor") return { argv: ["cursor-agent", "--resume", sessionId, message], paste: false };
  if (cli === "hermes") return { argv: ["hermes", "chat", "--resume", sessionId, "-q", message], paste: false };
  if (cli === "agy") return { argv: ["agy", "--conversation", sessionId, "-i", message], paste: false };
  return null;
}

const DEFERRED = "deferred: team-up starts it on its own when the machine has room";

/** What became of a run's worker in this resume, in words for the parent. */
export function workerOutcome(state, actions, { tmuxExists, deferred = null, staggered = false }) {
  if (deferred || (state.status === "waiting_capacity" && state.capacity?.reason === "resources")) {
    return `${DEFERRED} (${deferred ?? state.capacity?.admission?.reason ?? "resources"})`;
  }
  if (state.status === "waiting_human") {
    return actions.some((a) => a.kind === "spawn_worker") && staggered
      ? "waiting on a human answer; worker restarting first in line"
      : "waiting on a human answer";
  }
  if (state.status === "waiting_capacity") {
    const at = state.capacity?.resume_not_before;
    return at ? `waiting for capacity until ${at}` : "waiting for capacity";
  }
  if (state.status === "waiting_decision") return "waiting for a decision";
  if (actions.some((a) => a.kind === "spawn_worker")) return staggered ? "restarting, one worker at a time" : "restarted";
  if (state.worker?.tmux && tmuxExists(state.worker.tmux)) return "still running";
  return "no live worker";
}

function runLine(entry) {
  const { state, outcome } = entry;
  const role = String(state.role ?? "run").replace(/^specialist:/, "");
  const tmux = state.worker?.tmux ? `worker tmux: ${state.worker.tmux}` : "no worker tmux";
  const lines = [
    `- run ${state.runId}  ${role}  ${tmux} (${outcome})`,
    `    team-up runs wait ${state.runId} --ceiling-sec ${WATCH_CEILING_SEC}`,
  ];
  if (state.status === "waiting_human") {
    lines.push("    It asked a question: re-surface it to the human; do not invent an answer.");
  }
  return lines;
}

/**
 * The message a parent session gets when it comes back. Lists every run it
 * had in flight with the exact watcher command, points at unread results,
 * and says not to re-dispatch. Beyond ten runs the full list goes to
 * `overflowPath` and the message names it.
 */
export function renderParentWakeup({ entries, uncollected = [], restartReport = null, overflowPath = null }) {
  const head = restartReport?.verdict
    ? `Your session was resumed by team-up after a system restart (verdict: ${restartReport.verdict} — see ${restartReport.path ?? "the restart report"}).`
    : "Your session was resumed by team-up after a restart.";
  const listed = entries.length > MAX_LISTED && overflowPath ? entries.slice(0, MAX_LISTED) : entries;
  const lines = [
    head,
    "",
    `You had ${entries.length} team-up run${entries.length === 1 ? "" : "s"} in flight. Your watcher subagents did not survive.`,
    "For each run below, re-spawn ONE cheap watcher subagent whose only job is",
    "the command shown (skill `dispatch`, Path B):",
    "",
    ...listed.flatMap(runLine),
  ];
  if (listed.length < entries.length) {
    lines.push(`- … ${entries.length - listed.length} more, with their commands, in ${overflowPath}`);
  }
  const parked = entries.filter((e) => String(e.outcome).startsWith("deferred:")).length;
  if (parked) {
    lines.push(
      "",
      `${parked} run${parked === 1 ? " is" : "s are"} deferred to spare the machine. Watch ${parked === 1 ? "it" : "them"} like the rest;`,
      "the watcher waits until the worker has started and finished.",
    );
  }
  if (uncollected.length) {
    lines.push(
      "",
      `${uncollected.length} result${uncollected.length === 1 ? "" : "s"} finished before the crash and ${uncollected.length === 1 ? "has" : "have"} not been read:`,
      "    team-up runs uncollected   → then use skill `intake`",
    );
  }
  lines.push("", "Do not re-dispatch any of these runs.");
  return `${lines.join("\n")}\n`;
}

/** Write the full run list when the message would be too long to read. */
export function writeOverflow(entries, file) {
  if (entries.length <= MAX_LISTED) return null;
  atomicWriteText(file, `${entries.flatMap(runLine).join("\n")}\n`, { mode: 0o600 });
  return file;
}

export function overflowPath(logDir, key, now = new Date()) {
  const safe = String(key).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return path.join(logDir, `wakeup-${safe}-${now.toISOString().replace(/[:.]/g, "-")}.md`);
}
