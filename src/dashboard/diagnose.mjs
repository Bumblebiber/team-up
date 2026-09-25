// diagnose.mjs — one-click "why is this window STALE?" investigation.
//
// The dashboard can already show THAT a collector stopped reporting. Finding out
// WHY took a human an hour of expect-script instrumentation the last time
// (cursor-agent 2026.09.23, TIM ubun-0925-ns-01M3CPHFJ7XPVV1TSXVG55GQP8). This
// spawns an agent to do that legwork on demand, triggered from the STALE badge.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { packageRoot, teamUpHome, usageWatcherStatePath } from "../paths.mjs";
import { tmuxSessionExists } from "../runs/tmux.mjs";

export const DIAGNOSE_ROLE = "team-up-architect";

/** Where the spawned session name is remembered, so a second click joins it. */
export function diagnoseStatePath(cli, env = process.env) {
  return path.join(teamUpHome(env), `usage-diagnose-${cli}.json`);
}

function ageLine(updatedAt, now) {
  if (!updatedAt) return "never collected";
  const ms = now - Date.parse(updatedAt);
  if (!Number.isFinite(ms)) return `updated_at ${updatedAt} (unparseable)`;
  const min = Math.round(ms / 60_000);
  return min >= 120 ? `${Math.round(min / 60)}h old` : `${min}min old`;
}

/**
 * Pointers, not a pre-built evidence bundle: an agent with a shell finds the
 * evidence itself, and anything baked in here goes stale on the next CLI update.
 */
export function buildDiagnosePrompt({ cli, windows = {}, failures = [], now = Date.now() }) {
  const windowLines = Object.entries(windows)
    .filter(([key]) => key.startsWith(`${cli}:`))
    .map(([key, w]) => `- ${key}: used ${w.used ?? "?"}, updated_at ${w.updated_at ?? "null"} (${ageLine(w.updated_at, now)})`);
  const failureLines = failures.length
    ? failures.map((f) => `- ${f.at}: ${f.reason}`)
    : ["- (none recorded — the watcher may not have attempted a collect yet)"];

  return `Investigate why team-up's usage dashboard reports STALE for the CLI "${cli}".

A window is STALE when its \`updated_at\` is older than 2x usage_watcher.intervals.active_min
(see usageStaleThresholdMs in src/dashboard/data.mjs). That means the collector stopped
succeeding — the window key itself is usually fine.

## State when this investigation was started
${windowLines.length ? windowLines.join("\n") : `- (no ${cli}: windows in usage.json at all)`}

Last recorded collector failures (collect_failures.${cli}):
${failureLines.join("\n")}

## Your job
Find the ROOT CAUSE and report it in this terminal. Read-only investigation:
do NOT edit files, do NOT commit, do NOT restart the watcher service.
Report the smallest fix you would make and let the human apply it.

## Where to look
- \`${usageWatcherStatePath()}\` — collect_failures, last_collect, next_due
- \`journalctl --user -u team-up-usage-watcher --since "-3d" | grep -E "skip ${cli}:"\`
  The watcher records the collector's own reason; grouping those by kind tells you
  which failure class you are chasing.
- \`src/usage/usage-collect.mjs\` — the reasons: \`pty-lock-contention\` (benign,
  another collector held the lock), \`empty-parse\` (the CLI rendered, the parser
  matched nothing), or a thrown error / timeout.
- \`src/usage/usage-pty.mjs\` — \`buildExpectScript()\`. These expect anchors are
  literal strings from the CLI's TUI, so a CLI update is the usual culprit.
- \`src/collectors/parse-*.mjs\` — the parsers. \`parseCodexStatus\` needs
  \`<label> limit: … % left (resets …)\`; a status-bar-only pane yields empty-parse.

## Technique that found the last bug of this kind
1. Dump the script: \`node -e 'import("./src/usage/usage-pty.mjs").then(m=>console.log(m.buildExpectScript("${cli}",180)))' > /tmp/probe.exp\`
2. Insert \`puts stderr "STAGE n done"\` after every expect block.
3. Run \`expect -f /tmp/probe.exp\` by hand — the last STAGE printed is the anchor that hangs.
   The PTY_TIMEOUT_TAIL alone does not tell you which expect blocked.
4. Compare against the real TUI: start the CLI in tmux, drive it by hand, \`capture-pane -p\`.

## Constraints
- The PTY lock \`${path.join(teamUpHome(), ".usage-pty.lock")}\` serialises collectors.
  Booting ${cli} yourself contends with the 5-minute watcher; expect
  \`pty-lock-contention\` and retry rather than deleting the lock.
- Booting ${cli} spends real subscription quota — the quota you are measuring.
  A handful of probes is fine; a loop is not.
- Repo: ${packageRoot()} (branch state is the human's, leave it clean).
`;
}

/** @returns {{running: boolean, session: string|null, started_at: string|null}} */
export function readDiagnoseState(cli, { env = process.env, sessionExists = tmuxSessionExists } = {}) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(diagnoseStatePath(cli, env), "utf8"));
  } catch {
    return { running: false, session: null, started_at: null };
  }
  const session = typeof doc?.session === "string" ? doc.session : null;
  const running = Boolean(session) && sessionExists(session);
  return { running, session, started_at: doc?.started_at ?? null };
}

/** Parse the session name `spawnPinnedInTmux` prints. */
export function parseSpawnedSession(stdout) {
  const m = /^tmux session:\s*(\S+)$/m.exec(String(stdout || ""));
  return m ? m[1] : null;
}

/**
 * Spawn the investigation. No mailbox run: `runs create` demands a concrete
 * --worker-cli, which would pin one CLI and throw away the role chain that is
 * the whole point here (Opus first, GPT-6-Sol when Claude is quota-blocked).
 * The human watching the pane is the notification a mailbox would provide.
 */
export function spawnUsageDiagnosis(cli, {
  env = process.env,
  usage = {},
  failures = [],
  now = Date.now(),
  exec = execFileSync,
  sessionExists = tmuxSessionExists,
  teamUpBin = path.join(packageRoot(), "bin", "team-up.mjs"),
} = {}) {
  // Join rather than refuse, like the CLI install endpoints do: one click must
  // always end up looking at the investigation, first click or fifth.
  const existing = readDiagnoseState(cli, { env, sessionExists });
  if (existing.running) {
    return { ok: true, joined: true, session: existing.session, started_at: existing.started_at };
  }

  const prompt = buildDiagnosePrompt({ cli, windows: usage?.windows || {}, failures, now });
  const promptFile = path.join(teamUpHome(env), `usage-diagnose-${cli}.prompt.md`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt);

  const stdout = exec(process.execPath, [
    teamUpBin, "dispatch",
    "--role", DIAGNOSE_ROLE,
    "--prompt-file", promptFile,
    "--dir", packageRoot(),
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });

  const session = parseSpawnedSession(stdout);
  if (!session) {
    return { ok: false, status: 502, error: "dispatch did not report a tmux session", output: String(stdout).slice(-500) };
  }
  const started_at = new Date(now).toISOString();
  fs.writeFileSync(diagnoseStatePath(cli, env), `${JSON.stringify({ session, started_at, role: DIAGNOSE_ROLE }, null, 2)}\n`);
  return { ok: true, session, started_at };
}
