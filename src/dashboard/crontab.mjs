// The user's crontab, edited in exactly three ways and no other:
//
// 1. A built-in job's line is switched off by prefixing it with OFF and on by
//    removing that prefix — the line itself is never rewritten.
// 2. A built-in job's schedule or one whitelisted env knob in front of its
//    command is replaced; the command stays byte for byte.
// 3. Custom jobs live between BLOCK_START and BLOCK_END, a block generated
//    whole from cron-jobs.ini. Nothing outside it is ever added or removed.
//
// The crontab is shared with jobs team-up knows nothing about (TIM watchdogs,
// backups), so every write re-reads it first, keeps a backup, and checks that
// what cron now holds is what was written.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { teamUpHome } from "../paths.mjs";
import { parseSchedule } from "./cron-schedule.mjs";

export const OFF = "#team-up-off# ";
export const BLOCK_START = "# >>> team-up managed jobs — edit them in the dashboard, not here >>>";
export const BLOCK_END = "# <<< team-up managed jobs <<<";
const KEEP_BACKUPS = 20;

export function readCrontab({ exec = execFileSync } = {}) {
  try {
    return exec("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (/no crontab/i.test(`${e.stderr || ""}${e.message || ""}`)) return "";
    throw e;
  }
}

const ENTRY = /^(\s*)(@\w+|(?:\S+[ \t]+){4}\S+)[ \t]+(.+)$/;
const ENV_PREFIX = /^((?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*)(.*)$/;

/**
 * Lines that run something: `{ index, enabled, schedule, env, command, raw }`.
 * Comments (other than our OFF prefix), blank lines and `VAR=value` settings
 * are not entries. `env` is the `KEY=value` list in front of the command.
 */
export function cronEntries(text) {
  const entries = [];
  String(text).split("\n").forEach((raw, index) => {
    let line = raw;
    let enabled = true;
    if (line.startsWith(OFF)) {
      line = line.slice(OFF.length);
      enabled = false;
    } else if (!line.trim() || /^\s*#/.test(line)) {
      return;
    }
    if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) return;
    const m = line.match(ENTRY);
    if (!m) return;
    const [, envText, command] = m[3].match(ENV_PREFIX);
    const env = Object.fromEntries(envText.trim().split(/[ \t]+/).filter(Boolean).map((kv) => {
      const eq = kv.indexOf("=");
      return [kv.slice(0, eq), kv.slice(eq + 1)];
    }));
    entries.push({ index, enabled, schedule: m[2].replace(/[ \t]+/g, " "), env, command, raw });
  });
  return entries;
}

/** The one entry whose command contains `match`; throws when it is ambiguous. */
export function findEntry(text, match) {
  const hits = cronEntries(text).filter((e) => e.command.includes(match));
  if (hits.length > 1) throw new Error(`${hits.length} crontab lines run ${match}; edit them by hand`);
  return hits[0] ?? null;
}

function replaceLine(text, index, line) {
  const lines = String(text).split("\n");
  lines[index] = line;
  return lines.join("\n");
}

function rebuild(entry, { enabled = entry.enabled, schedule = entry.schedule, env = entry.env } = {}) {
  const envText = Object.entries(env).map(([k, v]) => `${k}=${v} `).join("");
  return `${enabled ? "" : OFF}${schedule} ${envText}${entry.command}`;
}

export function setEntryEnabled(text, match, enabled) {
  const entry = findEntry(text, match);
  if (!entry) throw new Error(`no crontab line runs ${match}`);
  if (entry.enabled === enabled) return text;
  // Only the prefix moves: an enabled line comes back exactly as it was.
  const line = enabled ? entry.raw.slice(OFF.length) : `${OFF}${entry.raw}`;
  return replaceLine(text, entry.index, line);
}

export function setEntrySchedule(text, match, schedule) {
  const entry = findEntry(text, match);
  if (!entry) throw new Error(`no crontab line runs ${match}`);
  const { expr } = parseSchedule(schedule);
  return replaceLine(text, entry.index, rebuild(entry, { schedule: expr }));
}

/** `value` null removes the knob, so the script's own default applies. */
export function setEntryEnv(text, match, key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`bad env name: ${key}`);
  if (value !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(String(value))) throw new Error(`bad value for ${key}`);
  const entry = findEntry(text, match);
  if (!entry) throw new Error(`no crontab line runs ${match}`);
  const env = { ...entry.env };
  if (value === null) delete env[key];
  else env[key] = String(value);
  return replaceLine(text, entry.index, rebuild(entry, { env }));
}

/** Replace (or add, or drop when `lines` is empty) the managed block. */
export function withManagedBlock(text, lines) {
  const all = String(text).split("\n");
  const start = all.indexOf(BLOCK_START);
  const end = all.indexOf(BLOCK_END);
  if ((start === -1) !== (end === -1) || end < start) {
    throw new Error("the crontab's team-up block is broken (a marker line is missing); fix it by hand");
  }
  const block = lines.length ? [BLOCK_START, ...lines, BLOCK_END] : [];
  if (start !== -1) {
    all.splice(start, end - start + 1, ...block);
  } else if (block.length) {
    // Keep the file's trailing newline after the block.
    const at = all.at(-1) === "" ? all.length - 1 : all.length;
    all.splice(at, 0, ...block);
  }
  const out = all.join("\n");
  return out && !out.endsWith("\n") ? `${out}\n` : out;
}

/** Lines inside the managed block, as written. */
export function managedLines(text) {
  const all = String(text).split("\n");
  const start = all.indexOf(BLOCK_START);
  const end = all.indexOf(BLOCK_END);
  return start === -1 || end < start ? [] : all.slice(start + 1, end);
}

export function crontabBackupDir(env = process.env) {
  return path.join(teamUpHome(env), "backups", "crontab");
}

/**
 * Read, apply `edit`, back up, install, verify. `edit` gets the freshly read
 * text, so a change made by hand a second ago is edited, not overwritten.
 * Returns `{ changed, backup }`.
 */
export function editCrontab(edit, { exec = execFileSync, env = process.env, now = new Date() } = {}) {
  const before = readCrontab({ exec });
  const after = edit(before);
  if (after === before) return { changed: false, backup: null };
  const dir = crontabBackupDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const backup = path.join(dir, `crontab-${now.toISOString().replace(/[:.]/g, "-")}.txt`);
  fs.writeFileSync(backup, before, { mode: 0o600 });
  const old = fs.readdirSync(dir).filter((f) => f.startsWith("crontab-")).sort().slice(0, -KEEP_BACKUPS);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  exec("crontab", ["-"], { input: after, stdio: ["pipe", "ignore", "pipe"] });
  if (readCrontab({ exec }) !== after) {
    throw new Error(`crontab did not take the edit; previous version saved at ${backup}`);
  }
  return { changed: true, backup };
}
