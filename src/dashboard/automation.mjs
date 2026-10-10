// Automation: every scheduled thing team-up runs, explained, plus jobs of your own.
//
// Built-in jobs are scheduled where they always were — the crontab or the
// Hermes cron daemon — and this module only reads that, and for crontab jobs
// switches a line on/off, moves its schedule, or sets one whitelisted knob.
// Custom jobs are defined in cron-jobs.ini (one section each, prompt in
// cron-prompts/NAME.md) and installed as the crontab's managed block, which is
// regenerated from the ini on every change: the ini is the one source of truth.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { teamUpHome } from "../paths.mjs";
import { describeSchedule, nextRun, parseSchedule } from "./cron-schedule.mjs";
import {
  cronEntries, editCrontab, findEntry, managedLines, readCrontab,
  setEntryEnabled, setEntryEnv, setEntrySchedule, withManagedBlock,
} from "./crontab.mjs";
import { cronJobsPath, parseCronSections, replaceCronSection } from "./cron-jobs.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const RUNNER = path.join(REPO, "scripts", "cron-job.sh");
const HOME = os.homedir();
const tilde = (p) => p.replace(HOME, "~");
const hermesOut = (name) => path.join(HOME, ".hermes", "cron-outputs", name);

/**
 * The jobs team-up ships, in plain words. `match` finds a job's crontab line
 * (or Hermes job) by the script it runs. `knobs` are env settings in front of
 * the command that the dashboard may set. `model` names its cron-jobs.ini
 * section when an LLM does the work.
 */
export const BUILTIN_JOBS = [
  {
    id: "usage-spender",
    title: "Usage spender",
    source: "crontab",
    match: "scripts/usage-spender.py",
    what: "Spends subscription quota that would otherwise expire unused. Every 10 minutes it holds each weekly window against a pacing curve; during the night hours it starts one task at a time — a PR review, a code audit, or a fix for a TIM task or GitHub issue in one of your repos. A host session collects the results and reports via Telegram.",
    cost: "Uses subscription quota — on purpose, only what would reset unused anyway.",
    llm: true,
    output: path.join(teamUpHome(), "reports", "usage-spender"),
    model: { job: "usage-spender-host", label: "Model of the morning host that collects the results" },
    settings: "spender",
    off: "Untick every subscription under Settings → Usage spender, or switch the job off here.",
  },
  {
    id: "insights",
    title: "Run insights",
    source: "crontab",
    match: "scripts/insights-cron.sh",
    what: "Reads the logs of all team-up runs every 48 hours and turns them into findings: failure reasons, stuck workers, slow paths. Only when the findings changed does an LLM judge them, write TIM entries, and prepare at most one fix — merged into main only if the tests pass in its clone.",
    cost: "LLM only when the findings changed — at most one evaluation every 2 days.",
    llm: true,
    output: hermesOut("insights"),
    model: { job: "insights", label: "Model of the evaluator" },
    knobs: [
      { key: "INSIGHTS_NO_MERGE", label: "Stop at the pull request (no auto-merge)", type: "flag" },
    ],
  },
  {
    id: "usage-watchdog",
    title: "Usage watchdog",
    source: "crontab",
    match: "usage-watchdog.sh",
    what: "Checks every minute that usage readings keep coming in. A stalled collector, a limit that should have reset, an unexplained jump or repeated failed reads send a Telegram message; otherwise it stays silent.",
    cost: "No LLM.",
    llm: false,
    output: hermesOut("usage-watchdog"),
  },
  {
    id: "stale-runs",
    title: "Stuck-run report",
    source: "crontab",
    match: "stale-runs.sh",
    what: "Lists team-up runs that are stuck — waiting on a human, a worker that died, a run that never started — and worker terminals that outlived their run, and sends them to Telegram. It never kills or cancels anything: whether someone is coming back is your call.",
    cost: "No LLM.",
    llm: false,
    output: hermesOut("stale-runs"),
    knobs: [
      { key: "STALE_RUNS_HOURS", label: "Report runs quiet for longer than", unit: "h", type: "int", min: 1, max: 720, default: 6 },
    ],
  },
  {
    id: "harness-health",
    title: "Harness health",
    source: "crontab",
    match: "harness-health.sh",
    what: "Runs `team-up doctor` every 2 hours — CLI versions, capability grants, harness verification — and reports high findings. It exists because a silent claude self-update once revoked every specialist launch and nothing noticed.",
    cost: "No LLM.",
    llm: false,
    output: hermesOut("harness-health"),
  },
  {
    id: "model-drift",
    title: "Model drift",
    source: "crontab",
    match: "model-drift.sh",
    what: "Daily: scans which models each CLI offers, moves role chains onto the newest version of a model family the roster already runs (pinned entries stay), and reports roster models a CLI no longer offers.",
    cost: "No LLM. Edits roster.json when a newer version ships.",
    llm: false,
    output: hermesOut("model-drift"),
  },
  {
    id: "golden-task",
    title: "Golden-task regression",
    source: "hermes",
    match: "golden-task-run.sh",
    what: "Once a month a worker solves a fixed reference task in ~/projects/golden-task, so a CLI or model update that breaks real work shows up before it bites.",
    cost: "LLM: one run per month.",
    llm: true,
    output: null,
    model: { job: "golden-task", label: "Model that solves the task" },
  },
  {
    id: "usage-safety-net",
    title: "Usage collector safety net",
    source: "hermes",
    match: "usage-collector-wrapper.sh",
    what: "Daily at 04:00: collects usage itself if the watcher service has not managed to for more than 25 hours.",
    cost: "No LLM.",
    llm: false,
    output: path.join(teamUpHome(), "reports", "usage-collector"),
  },
];

export const SERVICES = [
  { unit: "team-up-usage-watcher.service", title: "Usage watcher", what: "Reads each subscription's limits on an adaptive schedule — faster while agents run." },
  { unit: "team-up-gc.timer", title: "Cleanup", what: "Every 5 minutes: closes idle worker terminals and reaps runs whose worker is gone." },
  { unit: "team-up-telemetry.timer", title: "Telemetry", what: "Every 30 seconds: samples memory and pressure; sizes the worker limit." },
  { unit: "team-up-resume.service", title: "Resume after boot", what: "After a reboot, wakes the sessions whose runs were still going." },
  { unit: "team-up-dashboard.service", title: "Dashboard", what: "This page." },
];

export const JOB_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BUILTIN_SECTIONS = new Set(BUILTIN_JOBS.map((j) => j.model?.job).filter(Boolean));

export const promptsDir = (env = process.env) => path.join(teamUpHome(env), "cron-prompts");
export const jobLogPath = (name, env = process.env) => path.join(teamUpHome(env), "logs", "cron", `${name}.log`);

function newestMtime(dir) {
  if (!dir) return null;
  try {
    let newest = 0;
    for (const f of fs.readdirSync(dir)) {
      const st = fs.statSync(path.join(dir, f));
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
    }
    return newest ? new Date(newest).toISOString() : null;
  } catch {
    return null;
  }
}

function hermesJobs(env) {
  try {
    const file = path.join(env.HOME || HOME, ".hermes", "cron", "jobs.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(doc) ? doc : Array.isArray(doc?.jobs) ? doc.jobs : Object.values(doc?.jobs || doc || {});
    return list.filter((j) => j && typeof j === "object");
  } catch {
    return [];
  }
}

const when = (expr, now) => {
  try {
    return { text: describeSchedule(expr), next: nextRun(expr, now)?.toISOString() ?? null };
  } catch {
    return { text: `cron "${expr}"`, next: null };
  }
};

/** Last `=== start` / `=== end … exit N` pair of a custom job's log. */
export function lastRunFromLog(text) {
  const lines = String(text || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const end = lines[i].match(/^=== end (\S+) exit (\d+)/);
    if (end) return { at: end[1], exit: Number(end[2]), running: false };
    const start = lines[i].match(/^=== start (\S+)/);
    if (start) return { at: start[1], exit: null, running: true };
  }
  return null;
}

const customLine = (name, schedule) => `${schedule} ${RUNNER.includes(" ") ? `'${RUNNER}'` : RUNNER} ${name}`;

/** The managed block's lines for the ini's enabled custom jobs. */
export function customCronLines(sections) {
  return sections
    .filter((s) => s.values.custom === "true" && s.values.enabled !== "false" && JOB_NAME.test(s.name))
    .map((s) => {
      try {
        return customLine(s.name, parseSchedule(s.values.schedule).expr);
      } catch {
        return null; // an invalid hand edit stays out of cron rather than breaking it
      }
    })
    .filter(Boolean);
}

export function buildAutomationView({ env = process.env, exec = execFileSync, now = new Date(), modelOptions = [] } = {}) {
  let crontab = "";
  let crontabError = null;
  try {
    crontab = readCrontab({ exec });
  } catch (e) {
    crontabError = String(e.message || e).split("\n")[0];
  }
  const iniFile = cronJobsPath(env);
  const sections = fs.existsSync(iniFile) ? parseCronSections(fs.readFileSync(iniFile, "utf8")) : [];
  const section = (name) => sections.find((s) => s.name === name)?.values;
  const hermes = hermesJobs(env);

  const builtin = BUILTIN_JOBS.map((job) => {
    const base = {
      id: job.id, title: job.title, what: job.what, cost: job.cost, llm: job.llm, source: job.source,
      output: job.output ? tilde(job.output) : null, settings: job.settings ?? null, off: job.off ?? null,
      lastRun: newestMtime(job.output),
      model: job.model ? { ...job.model, value: section(job.model.job)?.model ?? null } : null,
    };
    if (job.source === "hermes") {
      const h = hermes.find((j) => JSON.stringify(j).includes(job.match));
      const expr = h?.schedule?.expr ?? h?.schedule ?? null;
      return {
        ...base,
        installed: !!h,
        enabled: h ? h.enabled !== false && h.paused !== true : false,
        editable: false,
        where: "Scheduled by the Hermes cron daemon (~/.hermes/cron/jobs.json) — change it there.",
        schedule: typeof expr === "string" ? expr : null,
        ...(typeof expr === "string" ? { when: when(expr, now) } : {}),
      };
    }
    let entry = null;
    let problem = null;
    try {
      entry = findEntry(crontab, job.match);
    } catch (e) {
      problem = e.message;
    }
    return {
      ...base,
      installed: !!entry,
      enabled: entry?.enabled ?? false,
      editable: !!entry && !crontabError,
      where: entry ? "Your crontab" : problem || "Not in your crontab",
      schedule: entry?.schedule ?? null,
      ...(entry ? { when: when(entry.schedule, now) } : {}),
      knobs: (job.knobs || []).map((k) => ({ ...k, value: entry?.env?.[k.key] ?? null })),
    };
  });

  const installed = new Set(managedLines(crontab));
  const custom = sections
    .filter((s) => s.values.custom === "true")
    .map(({ name, values }) => {
      let prompt = "";
      try {
        prompt = fs.readFileSync(path.join(promptsDir(env), `${name}.md`), "utf8");
      } catch { /* no prompt yet */ }
      let log = "";
      try {
        log = fs.readFileSync(jobLogPath(name, env), "utf8");
      } catch { /* never ran */ }
      const enabled = values.enabled !== "false";
      const line = (() => {
        try {
          return customLine(name, parseSchedule(values.schedule).expr);
        } catch {
          return null;
        }
      })();
      return {
        name,
        description: values.description ?? "",
        schedule: values.schedule ?? "",
        when: values.schedule ? when(values.schedule, now) : null,
        model: values.model ?? null,
        cwd: values.cwd ?? null,
        notify: values.notify === "true",
        enabled,
        prompt,
        lastRun: lastRunFromLog(log),
        // Out of sync = the crontab block does not say what the ini says.
        inSync: crontabError ? null : enabled ? !!line && installed.has(line) : ![...installed].some((l) => l.endsWith(` ${name}`)),
      };
    });

  let services = [];
  try {
    const out = exec("systemctl", ["--user", "show", "-p", "Id,ActiveState,SubState,UnitFileState", ...SERVICES.map((s) => s.unit)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const blocks = out.split(/\n\n+/).map((b) => Object.fromEntries(b.split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2))));
    services = SERVICES.map((s) => {
      const b = blocks.find((x) => x.Id === s.unit) || {};
      return { ...s, active: b.ActiveState ?? "unknown", sub: b.SubState ?? null, enabled: b.UnitFileState ?? "unknown" };
    });
  } catch {
    services = SERVICES.map((s) => ({ ...s, active: "unknown", sub: null, enabled: "unknown" }));
  }

  const otherLines = cronEntries(crontab).filter((e) =>
    !BUILTIN_JOBS.some((j) => e.command.includes(j.match)) && !installed.has(e.raw)).length;

  return {
    now: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    crontab: { readable: !crontabError, error: crontabError, otherLines },
    builtin,
    custom,
    services,
    options: { models: modelOptions },
  };
}

// ── Edits ────────────────────────────────────────────────────────────────

export function editBuiltin({ id, enabled, schedule, knob }, { exec = execFileSync, env = process.env } = {}) {
  const job = BUILTIN_JOBS.find((j) => j.id === id);
  if (!job) throw new Error(`unknown job: ${id}`);
  if (job.source !== "crontab") throw new Error(`${job.title} is scheduled by Hermes; change it in ~/.hermes/cron/jobs.json`);
  return editCrontab((text) => {
    let next = text;
    if (schedule !== undefined) next = setEntrySchedule(next, job.match, schedule);
    if (enabled !== undefined) {
      if (typeof enabled !== "boolean") throw new Error("enabled must be true or false");
      next = setEntryEnabled(next, job.match, enabled);
    }
    if (knob !== undefined) {
      const spec = (job.knobs || []).find((k) => k.key === knob?.key);
      if (!spec) throw new Error(`${job.title} has no setting ${knob?.key}`);
      let value = knob.value;
      if (spec.type === "flag") value = value ? "1" : null;
      else if (value !== null) {
        if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
          throw new Error(`${spec.label} must be a whole number from ${spec.min} to ${spec.max}`);
        }
      }
      next = setEntryEnv(next, job.match, spec.key, value);
    }
    return next;
  }, { exec, env });
}

/** A directory inside the home folder, resolved — never taken from the browser as text. */
export function checkJobDir(input) {
  const home = fs.realpathSync(HOME);
  const raw = String(input || "").trim();
  if (!raw || /[\r\n]/.test(raw)) throw new Error("project folder is required");
  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(home, raw.slice(1)) : raw;
  let real;
  try {
    real = fs.realpathSync(expanded);
  } catch {
    throw new Error(`no such folder: ${raw}`);
  }
  if (!real.startsWith(home + path.sep)) throw new Error("project folder must be inside your home folder");
  if (!fs.statSync(real).isDirectory()) throw new Error(`not a folder: ${raw}`);
  return real;
}

function syncBlock(sections, { exec, env }) {
  return editCrontab((text) => withManagedBlock(text, customCronLines(sections)), { exec, env });
}

function readIni(env) {
  const file = cronJobsPath(env);
  return { file, text: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# team-up scheduled jobs (dashboard → Automation)\n" };
}

function writeIni(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * Create or replace a custom job. `original` names the job being edited, so a
 * rename moves it. Every field is checked here; the browser's word is never
 * written into the crontab — only the checked schedule and the job name are.
 */
export function saveCustomJob(input, { exec = execFileSync, env = process.env, modelOptions = [] } = {}) {
  const name = String(input?.name || "");
  if (!JOB_NAME.test(name)) throw new Error("name: lowercase letters, digits and -, starting with a letter or digit");
  if (BUILTIN_SECTIONS.has(name)) throw new Error(`${name} is a built-in job's name`);
  const original = input.original ? String(input.original) : null;
  const { expr } = parseSchedule(input.schedule);
  if (!modelOptions.includes(input.model)) throw new Error("model: pick one of the offered CLI:model pairs");
  const cwd = checkJobDir(input.cwd);
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required — it is what the worker is told to do");
  if (prompt.length > 20000) throw new Error("prompt is too long (max 20 000 characters)");
  const description = String(input.description || "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const enabled = input.enabled !== false;
  const notify = input.notify === true;

  const { file, text } = readIni(env);
  const sections = parseCronSections(text);
  const exists = (n) => sections.some((s) => s.name === n);
  if ((!original || original !== name) && exists(name)) throw new Error(`a job named ${name} already exists`);
  if (original && !sections.some((s) => s.name === original && s.values.custom === "true")) {
    throw new Error(`no custom job named ${original}`);
  }

  let next = text;
  if (original && original !== name) next = replaceCronSection(next, original, null);
  next = replaceCronSection(next, name, [
    "custom = true",
    `description = ${description}`,
    `schedule = ${expr}`,
    `model = ${input.model}`,
    `cwd = ${cwd}`,
    `notify = ${notify}`,
    `enabled = ${enabled}`,
  ]);
  const dir = promptsDir(env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `${prompt}\n`);
  if (original && original !== name) fs.rmSync(path.join(dir, `${original}.md`), { force: true });
  writeIni(file, next);
  return syncBlock(parseCronSections(next), { exec, env });
}

export function setCustomJobEnabled(name, enabled, { exec = execFileSync, env = process.env } = {}) {
  const { file, text } = readIni(env);
  const sections = parseCronSections(text);
  const job = sections.find((s) => s.name === name && s.values.custom === "true");
  if (!job) throw new Error(`no custom job named ${name}`);
  const lines = Object.entries({ ...job.values, enabled: String(enabled === true) }).map(([k, v]) => `${k} = ${v}`);
  const next = replaceCronSection(text, name, lines);
  writeIni(file, next);
  return syncBlock(parseCronSections(next), { exec, env });
}

export function deleteCustomJob(name, { exec = execFileSync, env = process.env } = {}) {
  const { file, text } = readIni(env);
  if (!parseCronSections(text).some((s) => s.name === name && s.values.custom === "true")) {
    throw new Error(`no custom job named ${name}`);
  }
  const next = replaceCronSection(text, name, null);
  writeIni(file, next);
  fs.rmSync(path.join(promptsDir(env), `${name}.md`), { force: true });
  return syncBlock(parseCronSections(next), { exec, env });
}

/** Start a custom job now, detached; its output lands in the job's log. */
export function runCustomJobNow(name, { env = process.env, spawnFn = spawn } = {}) {
  const { text } = readIni(env);
  if (!parseCronSections(text).some((s) => s.name === name && s.values.custom === "true")) {
    throw new Error(`no custom job named ${name}`);
  }
  const child = spawnFn(RUNNER, [name], { detached: true, stdio: "ignore", env: { ...env, TEAMUP_WORKER: "" } });
  child.unref();
  return { started: true };
}

export function readJobLog(name, { env = process.env, maxBytes = 64 * 1024 } = {}) {
  if (!JOB_NAME.test(name)) throw new Error("bad job name");
  try {
    const buf = fs.readFileSync(jobLogPath(name, env));
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8");
  } catch {
    return "";
  }
}
