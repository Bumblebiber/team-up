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

export function buildCommand({ roster, model, cli, prompt, effort }) {
  const template = roster.clis?.[cli]?.cmd;
  if (!template) throw new Error(`no cli template for "${cli}" in roster.json clis section`);
  const cliModel = roster.models?.[model]?.cli_model || model;
  const resolvedEffort = effort !== undefined
    ? effort
    : resolveEffort({ roster, role: null, model, cellEffort: undefined });
  const out = [];
  for (let i = 0; i < template.length; i++) {
    const part = template[i];
    if (part.includes("{effort}")) {
      if (resolvedEffort == null || resolvedEffort === "") {
        // Drop flag/value pair when previous token looks like a flag for this value slot
        if (out.length && typeof out[out.length - 1] === "string" && out[out.length - 1].startsWith("-")) {
          out.pop();
        }
        continue;
      }
      out.push(part.replaceAll("{model}", cliModel).replaceAll("{prompt}", prompt).replaceAll("{effort}", String(resolvedEffort)));
      continue;
    }
    out.push(part.replaceAll("{model}", cliModel).replaceAll("{prompt}", prompt));
  }
  return out;
}

/** Cell → role → model effort precedence. */
export function resolveEffort({ roster, role, model, cellEffort }) {
  if (cellEffort !== undefined) return cellEffort;
  if (role && roster?.roles?.[role]?.effort !== undefined) return roster.roles[role].effort;
  if (model && roster?.models?.[model]?.effort !== undefined) return roster.models[model].effort;
  return undefined;
}

function shellQuote(s) {
  return /^[A-Za-z0-9_\-./=]+$/.test(s) ? s : "'" + s.replaceAll("'", "'\\''") + "'";
}

/** Pure tmux argv builder — spawn itself stays a one-liner around this. */
export function tmuxArgs({ session, dir, argv }) {
  return ["new-session", "-d", "-s", session, "-c", dir, argv.map(shellQuote).join(" ")];
}

/** Spawn a pinned CLI×model in detached tmux (no role chain / usage pick). */
export async function spawnPinnedInTmux({
  roster,
  model,
  cli,
  dir,
  prompt,
  runId,
  effort,
  sessionPrefix = "team-up-pass",
}) {
  if (!roster.clis?.[cli]?.cmd) {
    console.error(`no cli template for "${cli}" in roster.json clis section`);
    process.exit(1);
  }
  const argv = buildCommand({ roster, model, cli, prompt, effort });
  const session = `${sessionPrefix}-${Date.now().toString(36)}`;
  execFileSync("tmux", tmuxArgs({ session, dir, argv }), { stdio: "inherit" });
  linkDispatchToRun(runId, session);
  console.log(`model: ${model} (${cli})`);
  if (effort !== undefined && effort !== null && effort !== "") console.log(`effort: ${effort}`);
  console.log(`tmux session: ${session}`);
  console.log(`attach: tmux attach -t ${session}`);
  return { session, model, cli, effort };
}
