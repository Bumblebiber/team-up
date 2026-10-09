// The TIM panel: every project's open tasks, bugs and ideas, each one a
// clickable start button for a session in that project's repo.
//
// TIM owns the read — `tim open-work` is its JSON surface — and the marker
// files own the project → directory mapping. The dashboard never opens the TIM
// database. No `tim` on PATH (or an older one without the command) means the
// panel is simply not there.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureAgyWorkspaceTrusted } from "../roster/agy-trust.mjs";
import { tmuxArgs } from "../roster/command.mjs";
import { cliModelFor } from "../roster/config.mjs";
import { listTmuxSessions } from "../runs/tmux.mjs";
import { loadInstalledManifest } from "../specialists/store.mjs";
import { resolveCollectingDir, SESSION_PREFIX } from "./projects.mjs";

const slug = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, "-");

/**
 * CLIs whose bare binary takes the initial prompt as its first positional and
 * stays interactive: `claude "…"`, `codex "…"`, `cursor-agent "…"`.
 * agy needs `-i`. opencode reads that position as a project path and hermes as
 * a subcommand, so a Start button for them would open a session that never sees
 * the task.
 */
const PROMPT_CLIS = new Set(["claude", "codex", "cursor", "agy"]);

export const promptClis = (roster) =>
  Object.keys(roster?.clis || {}).filter((c) => PROMPT_CLIS.has(c)).sort();

export const taskSessionName = (project, cli, entryId) =>
  `${SESSION_PREFIX}${slug(project)}-${slug(cli)}-${slug(entryId)}`;

/** `tim open-work`, or null when TIM is not installed and the panel stays hidden. */
export function readOpenWork({ exec = execFileSync } = {}) {
  try {
    const raw = exec("tim", ["open-work"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
    const data = JSON.parse(raw);
    return Array.isArray(data?.items) && Array.isArray(data?.projects) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Project label → repository directory, read from the `.tim-project` markers in
 * the collecting folder. The marker is what TIM itself resolves a directory
 * with, so a project that has no repo here simply has no directory — its items
 * are listed but cannot start a session.
 */
export function projectDirs(collectingDir) {
  const dirs = {};
  for (const name of fs.readdirSync(collectingDir)) {
    if (name.startsWith(".")) continue;
    const full = path.join(collectingDir, name);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      const marker = JSON.parse(fs.readFileSync(path.join(full, ".tim-project"), "utf8"));
      if (typeof marker?.project === "string") dirs[marker.project] = full;
    } catch {
      // No marker, unreadable, or not JSON: not a TIM project directory.
    }
  }
  return dirs;
}

/**
 * The specialist's own contract, prepended to the prompt. An interactive
 * session can carry its remit as text and nothing else: the sandbox, the
 * project policy trust and the RESULT.json contract belong to a real specialist
 * launch (`team-up specialist run`), which this deliberately is not.
 */
export function specialistFraming(id, { env = process.env } = {}) {
  const loaded = loadInstalledManifest(id, { env });
  if (!loaded) return null;
  const manifest = loaded.manifest || {};
  const remit = manifest.remit || [];
  const antiRemit = manifest.anti_remit || [];
  return [
    `You are acting as ${manifest.display_name || id} (${id}@${loaded.version}).`,
    remit.length ? `Your remit: ${remit.join("; ")}.` : null,
    antiRemit.length ? `Outside your remit — stop and ask instead of doing it: ${antiRemit.join("; ")}.` : null,
    "This is an interactive session, not a sandboxed specialist run: no RESULT.json is expected.",
    "",
  ].filter((l) => l !== null).join("\n");
}

/** What the session is opened with unless the user rewrites it in the dialog. */
export const defaultPrompt = (item) =>
  `Work on TIM ${item.kind} ${item.id}: ${item.title}. `
  + `Read the entry first with tim_read("${item.id}") for the full context, then do the work in this repo.`;

export function buildTimView(dirInput, { exec = execFileSync, sessions = null, work = null } = {}) {
  const report = work ?? readOpenWork({ exec });
  if (!report) return { installed: false, projects: [] };
  const dir = resolveCollectingDir(dirInput);
  const dirs = projectDirs(dir);
  const live = sessions ?? listTmuxSessions({ exec });
  const titles = new Map(report.projects.map((p) => [p.label, p.title]));

  const byProject = new Map();
  for (const item of report.items) {
    const project = byProject.get(item.project) ?? {
      label: item.project,
      title: titles.get(item.project) ?? item.project,
      dir: dirs[item.project] ?? null,
      items: [],
    };
    project.items.push({
      ...item,
      prompt: defaultPrompt(item),
      // Any CLI's session for this entry counts as running: the name carries
      // the cli between the project and the id.
      sessions: project.dir
        ? live.filter((s) => s.startsWith(`${SESSION_PREFIX}${slug(path.basename(project.dir))}-`)
            && s.endsWith(`-${slug(item.id)}`)).sort()
        : [],
    });
    byProject.set(item.project, project);
  }

  const projects = [...byProject.values()]
    .sort((a, b) => a.title.localeCompare(b.title));
  return { installed: true, dir, projects };
}

/**
 * A session in the project's repo, opened on one entry. The entry is looked up
 * again here: the browser sends an id, never a directory or a prompt.
 *
 * Deliberately the bare binary plus the prompt as its first argument, like the
 * Projects panel — the templated roster form carries --dangerously-* flags for
 * a dispatched worker, and this is a session Benni drives himself.
 * ponytail: `<bin> "<prompt>"` starts interactive on claude/codex/cursor-agent;
 * a CLI that needs a flag for it would need a per-cli form here.
 */
export function startTaskSession({
  id,
  cli,
  prompt,
  specialist = null,
  model = null,
  projectsDir,
  roster,
  env = process.env,
  exec = execFileSync,
  sessions = null,
} = {}) {
  const cmd = PROMPT_CLIS.has(cli) ? roster?.clis?.[cli]?.cmd?.[0] : null;
  if (!cmd) return { ok: false, status: 400, error: `cli cannot take a prompt: ${cli}` };
  // A model the roster does not list would reach the CLI as an unchecked flag,
  // and one the roster does not run on this CLI is a guaranteed start failure.
  if (model && !roster?.models?.[model]) {
    return { ok: false, status: 400, error: `unknown model: ${model}` };
  }
  if (model && !(roster.models[model].cli || []).includes(cli)) {
    return { ok: false, status: 400, error: `${model} does not run on ${cli}` };
  }
  const framing = specialist ? specialistFraming(specialist, { env }) : null;
  if (specialist && !framing) {
    return { ok: false, status: 400, error: `specialist not installed: ${specialist}` };
  }

  const work = readOpenWork({ exec });
  if (!work) return { ok: false, status: 503, error: "tim open-work is not available" };
  const item = work.items.find((i) => i.id === id);
  if (!item) return { ok: false, status: 404, error: "no such open entry" };

  const collecting = resolveCollectingDir(projectsDir);
  const dir = projectDirs(collecting)[item.project];
  if (!dir) {
    return { ok: false, status: 404, error: `no .tim-project marker for ${item.project} in ${collecting}` };
  }

  const session = taskSessionName(path.basename(dir), cli, id);
  const live = sessions ?? listTmuxSessions({ exec });
  if (live.includes(session)) return { ok: true, session, existing: true };

  // The dialog hands back an edited prompt; an empty one falls back to the
  // default. The directory is never taken from the browser — only the id is.
  const text = String(prompt || "").trim() || defaultPrompt(item);
  // `--model` is spelled the same by claude, codex, cursor-agent, and agy, the
  // model-taking CLIs this panel offers (PROMPT_CLIS). Its value is the CLI's own
  // name for the model, not the roster id: `claude --model claude-sonnet` is
  // refused by the CLI, `--model sonnet` is what it answers to.
  const promptText = framing ? `${framing}\n${text}` : text;
  const flag = model ? ["--model", cliModelFor(roster, model, cli)] : [];
  if (cli === "agy") ensureAgyWorkspaceTrusted(dir, { env });
  const argv = cli === "agy"
    ? [cmd, ...flag, "-i", promptText]
    : [cmd, ...flag, promptText];
  exec("tmux", tmuxArgs({ session, dir, argv, env: { TEAMUP_WORKER: "" } }), { stdio: "ignore" });
  return { ok: true, session, existing: false };
}
