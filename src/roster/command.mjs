import { cliModelFor } from "./config.mjs";
import { execFileSync } from "node:child_process";
import { linkDispatchToRun } from "../runs/runs.mjs";

/** First non-flag argv token; skips values that belong to --flags. */
export function firstPositional(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

/**
 * CLI-native effort string for a spawn. Highest wins:
 * chain-entry.effort > roles.<role>.effort > models.<id>.effort > null.
 * Accepts entryEffort or cellEffort (plan alias).
 */
export function resolveEffort({ roster, role, model, entryEffort, cellEffort }) {
  return entryEffort || cellEffort || roster?.roles?.[role]?.effort || roster?.models?.[model]?.effort || null;
}

export function buildCommand({ roster, model, cli, prompt, effort = null }) {
  const template = roster.clis?.[cli]?.cmd;
  if (!template) throw new Error(`no cli template for "${cli}" in roster.json clis section`);
  const cliModel = cliModelFor(roster, model, cli);
  const hasSlot = template.some((p) => p.includes("{effort}"));
  if (effort && !hasSlot) {
    console.error(`roster: effort "${effort}" set but clis.${cli}.cmd has no {effort} — ignored`);
  }
  const argv = [];
  for (let i = 0; i < template.length; i++) {
    const part = template[i];
    if (part.includes("{effort}") && !effort) {
      if (argv.length && template[i - 1]?.startsWith("-")) argv.pop();
      continue;
    }
    argv.push(
      part.replaceAll("{model}", cliModel)
        .replaceAll("{prompt}", prompt)
        .replaceAll("{effort}", effort ?? "")
    );
  }
  return argv;
}

function shellQuote(s) {
  return /^[A-Za-z0-9_\-./=]+$/.test(s) ? s : "'" + s.replaceAll("'", "'\\''") + "'";
}

/**
 * Pure tmux argv builder — spawn itself stays a one-liner around this.
 * `env` becomes `-e K=V` flags: how a spawned worker proves to itself that it
 * is a worker and not the interface agent talking to a human.
 *
 * TEAMUP_WORKER=1 is the default because every caller of this builder spawns a
 * worker. Anything that spawns a parent/interface session must NOT route
 * through here (see executeResumeAction in runs/runs.mjs).
 */
export function tmuxArgs({ session, dir, argv, env = {} }) {
  const envFlags = Object.entries({ TEAMUP_WORKER: "1", ...env })
    .filter(([, v]) => v)
    .flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return ["new-session", "-d", "-s", session, "-c", dir, ...envFlags, argv.map(shellQuote).join(" ")];
}

/** Spawn a pinned CLI×model in detached tmux (no role chain / usage pick). */
export async function spawnPinnedInTmux({
  roster,
  model,
  cli,
  dir,
  prompt,
  runId,
  effort = null,
  sessionPrefix = "team-up-pass",
}) {
  if (!roster.clis?.[cli]?.cmd) {
    console.error(`no cli template for "${cli}" in roster.json clis section`);
    process.exit(1);
  }
  const argv = buildCommand({ roster, model, cli, prompt, effort });
  const session = `${sessionPrefix}-${Date.now().toString(36)}`;
  execFileSync("tmux", tmuxArgs({ session, dir, argv, env: { TEAMUP_RUN_ID: runId } }), { stdio: "inherit" });
  linkDispatchToRun(runId, session);
  console.log(`model: ${model} (${cli})`);
  if (effort) console.log(`effort: ${effort}`);
  console.log(`tmux session: ${session}`);
  console.log(`attach: tmux attach -t ${session}`);
  return { session, model, cli, effort };
}
