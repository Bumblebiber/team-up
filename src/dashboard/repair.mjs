// repair.mjs — one-click "make this collector work again".
//
// A usage collector breaks whenever a vendor reshuffles its TUI: the expect
// anchors in usage-pty.mjs are literal strings from someone else's UI. The
// cause differs every time (cursor-agent 2026.09.23 paginated its slash menu,
// an earlier break was a missing `import os`), so the button does not explain
// the cause — it dispatches an agent to fix it and prove the fix.
//
// What makes autonomous repair defensible here is the objective success test:
// `usage-collect.mjs --cli <cli>` either prints real numbers or it does not.
// That same test is what an agent could game, so the prompt spends most of its
// words on what may NOT be touched.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { packageRoot, teamUpHome, usageWatcherStatePath } from "../paths.mjs";
import { tmuxSessionExists } from "../runs/tmux.mjs";

export const REPAIR_ROLE = "team-up-architect";

/** Where the spawned session name is remembered, so a second click joins it. */
export function repairStatePath(cli, env = process.env) {
  return path.join(teamUpHome(env), `usage-repair-${cli}.json`);
}

/** The agent's write-up, kept outside the pane so it survives the gc sweep. */
export function repairReportPath(cli, env = process.env) {
  return path.join(teamUpHome(env), `usage-repair-${cli}.report.md`);
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
export function buildRepairPrompt({ cli, windows = {}, failures = [], now = Date.now(), env = process.env }) {
  const windowLines = Object.entries(windows)
    .filter(([key]) => key.startsWith(`${cli}:`))
    .map(([key, w]) => `- ${key}: used ${w.used ?? "?"}, updated_at ${w.updated_at ?? "null"} (${ageLine(w.updated_at, now)})`);
  const failureLines = failures.length
    ? failures.map((f) => `- ${f.at}: ${f.reason}`)
    : ["- (none recorded — the watcher may not have attempted a collect yet)"];
  const repo = packageRoot();

  return `Repair team-up's usage collector for the CLI "${cli}". It stopped reporting, so
the dashboard shows its windows as STALE. Fix the cause and prove the fix.

The cause is different every time a vendor ships a TUI change, so do not assume
it is the last one. Find this one.

## Done means
\`cd ${repo} && node src/usage/usage-collect.mjs --cli ${cli}\`
prints \`ok ${cli}: <window keys>\` and exits 0 — AND the numbers it writes match
what ${cli}'s own usage screen shows when you look at it by hand.

Then, both green:
- \`cd ${repo} && npm test\`
- one more \`node src/usage/usage-collect.mjs --cli ${cli}\` (the first success must repeat)

## State when this repair was started
${windowLines.length ? windowLines.join("\n") : `- (no ${cli}: windows in usage.json at all)`}

Last recorded collector failures (collect_failures.${cli}):
${failureLines.join("\n")}

## You may NOT "fix" it by making it lie
usage.json feeds an automated gate: \`team-up pick\` refuses a model whose window
is at/over the limit. A wrong number is worse than a missing one — a fabricated
low reading sends work to an exhausted subscription. So, forbidden:
- writing or editing ~/.team-up/usage.json by hand, or touching updated_at anywhere
- inventing, defaulting or zero-filling a value the CLI did not actually report
- widening the stale threshold, lengthening collect intervals, or removing the window
- deleting, skipping or weakening a test, or making the collector exit 0 on failure
If you conclude the honest answer is "this CLI cannot be collected right now"
(logged out, vendor removed the screen), then STOP, change nothing, and say so
in your report. That is a valid outcome.

## Where to look
- \`src/usage/usage-pty.mjs\` — \`buildExpectScript()\`. The expect anchors are literal
  strings from the CLI's TUI and are the usual culprit.
- \`src/collectors/parse-*.mjs\` — the parsers. \`parseCodexStatus\` needs
  \`<label> limit: … % left (resets …)\`; a status-bar-only pane yields empty-parse.
- \`src/usage/usage-collect.mjs\` — the reasons: \`pty-lock-contention\` (benign, retry),
  \`empty-parse\` (CLI rendered, parser matched nothing), or a thrown error / timeout.
- \`${usageWatcherStatePath(env)}\` — collect_failures, last_collect, next_due
- \`journalctl --user -u team-up-usage-watcher --since "-3d" | grep -E "skip ${cli}:"\`

## Technique that found the last two breaks
1. Dump the script: \`node -e 'import("./src/usage/usage-pty.mjs").then(m=>console.log(m.buildExpectScript("${cli}",180)))' > /tmp/probe.exp\`
2. Insert \`puts stderr "STAGE n done"\` after every expect block.
3. Run \`expect -f /tmp/probe.exp\` by hand — the last STAGE printed is the anchor that hangs.
   The PTY_TIMEOUT_TAIL alone does not tell you which expect blocked.
4. Compare against the real TUI: start ${cli} in tmux, drive it by hand, \`capture-pane -p\`.
   The pane is the ground truth for both the anchors and the expected numbers.

## Constraints
- The PTY lock \`${path.join(teamUpHome(env), ".usage-pty.lock")}\` serialises collectors.
  Booting ${cli} contends with the 5-minute watcher; on \`pty-lock-contention\` retry,
  never delete the lock.
- Booting ${cli} spends real subscription quota — the quota you are measuring.
  A handful of probes is fine; a loop is not.
- Leave a regression test behind: the anchor or parser you fixed should fail the
  test if it regresses. Extend the nearest existing test file, no new framework.
- Commit only the files you changed (\`git add <paths>\`, never \`git add -A\`) as one
  commit on the current branch. If the tree holds unrelated changes, leave them.
- Repo: ${repo}

## Report
Write what you changed and the evidence to \`${repairReportPath(cli, env)}\`:
the root cause, the pane excerpt that proves it, the collector output before and
after, and the test you added. Keep it short. The pane you are typing in gets
swept ~40 minutes after it goes idle; that file is what survives.
`;
}

/** @returns {{running: boolean, session: string|null, started_at: string|null}} */
export function readRepairState(cli, { env = process.env, sessionExists = tmuxSessionExists } = {}) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(repairStatePath(cli, env), "utf8"));
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
 * Spawn the repair. No explicit mailbox run: `runs create` demands a concrete
 * --worker-cli, which would pin one CLI and throw away the role chain that is
 * the point here (Opus first, GPT-6-Sol when Claude is quota-blocked). dispatch
 * creates a run of its own anyway, and the report file is the durable artefact.
 */
export function spawnUsageRepair(cli, {
  env = process.env,
  usage = {},
  failures = [],
  now = Date.now(),
  exec = execFileSync,
  sessionExists = tmuxSessionExists,
  teamUpBin = path.join(packageRoot(), "bin", "team-up.mjs"),
} = {}) {
  // Join rather than refuse, like the CLI install endpoints do: one click must
  // always end up looking at the repair, first click or fifth.
  const existing = readRepairState(cli, { env, sessionExists });
  if (existing.running) {
    return { ok: true, joined: true, session: existing.session, started_at: existing.started_at };
  }

  const prompt = buildRepairPrompt({ cli, windows: usage?.windows || {}, failures, now, env });
  const promptFile = path.join(teamUpHome(env), `usage-repair-${cli}.prompt.md`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt);
  // A stale report from an earlier attempt must not read as this one's result.
  try {
    fs.unlinkSync(repairReportPath(cli, env));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  const stdout = exec(process.execPath, [
    teamUpBin, "dispatch",
    "--role", REPAIR_ROLE,
    "--prompt-file", promptFile,
    "--dir", packageRoot(),
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });

  const session = parseSpawnedSession(stdout);
  if (!session) {
    return { ok: false, status: 502, error: "dispatch did not report a tmux session", output: String(stdout).slice(-500) };
  }
  const started_at = new Date(now).toISOString();
  fs.writeFileSync(repairStatePath(cli, env), `${JSON.stringify({ session, started_at, role: REPAIR_ROLE }, null, 2)}\n`);
  return { ok: true, session, started_at };
}

/** The last repair write-up, for the dashboard to show next to the badge. */
export function readRepairReport(cli, { env = process.env, maxBytes = 8000 } = {}) {
  try {
    const text = fs.readFileSync(repairReportPath(cli, env), "utf8");
    return { present: true, text: text.slice(0, maxBytes) };
  } catch {
    return { present: false, text: null };
  }
}
