// Communication: where team-up's and TIM's messages reach Benni, and what a
// reply to one does.
//
// ~/.team-up/communication.json:
//   bots     Telegram bots, each an env file in the format ~/.hermes/bin/send-telegram
//            reads; `listen` = replies to it are acted on; `owner` = another
//            program already reads its replies, so team-up never polls it.
//   routes   sender -> bot id or "bell" (dashboard bell only, no push).
//   default  where every sender without a route goes ("Everything not listed").
//   replies  the claude model, folder and extra instructions for a reply that
//            starts a new session.
// Tokens never leave their env file: views show @username and the last four
// characters only.
//
// The sending and the replies are scripts/telegram.py (see its docstring):
// ~/.hermes/bin/send-cron-telegram calls `telegram.py send` for every report,
// team-up-telegram-replies.service runs `telegram.py serve`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadJson, atomicWriteJson, atomicWriteText } from "../json-store.mjs";
import { teamUpHome } from "../paths.mjs";
import { t } from "./i18n.mjs";
import { BUILTIN_JOBS } from "./automation.mjs";
import { findEntry, readCrontab } from "./crontab.mjs";
import { cronJobsPath, parseCronSections } from "./cron-jobs.mjs";

const HOME = os.homedir();
const tilde = (p) => p.replace(HOME, "~");
export const commPath = (env = process.env) => path.join(teamUpHome(env), "communication.json");
export const botDir = (env = process.env) => path.join(teamUpHome(env), "telegram");
const SENDER = /^[A-Za-z0-9._-]{1,64}$|^\*$/;
const DEFAULT_REPLIES = { model: "claude:claude-sonnet", cwd: path.join(HOME, "projects", "team-up"), instructions: "" };

/** Bots that existed before this page. Another process owns their getUpdates. */
const KNOWN = [
  { file: path.join(HOME, ".hermes/secrets/cron-telegram.env"), owner: null, isDefault: true },
  { file: path.join(HOME, ".hermes/secrets/telegram.env"), owner: "reminderbot-guard.sh (reminders)" },
  { file: path.join(HOME, ".claude/channels/telegram/.env"), owner: "the Claude Code telegram plugin (Overseer chat)" },
];

/** TIM's watchdogs, scheduled in the crontab next to team-up's jobs. */
export const TIM_SENDERS = [
  { key: "tim-db-header-watchdog", title: "TIM database check", match: "tim-db-header-watchdog.sh", notifies: "Every 15 min, only when the database looks damaged." },
  { key: "tim-wal-watchdog", title: "TIM database size", match: "tim-wal-watchdog.sh", notifies: "Hourly, only when TIM's working file grew past 50 MB and was trimmed." },
  { key: "tim-snapshot-watchdog", title: "TIM backups", match: "tim-snapshot-watchdog.sh", notifies: "Hourly, only when the newest snapshot is older than 2 hours." },
];

/** The key telegram.py derives for a script: its file name without .sh/.py. */
export const senderKey = (match) => path.basename(match).replace(/\.(sh|py)$/, "");

export function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*?)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export async function getMe(token, { fetchFn = fetch } = {}) {
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error("that does not look like a bot token (123456:ABC…)");
  let body;
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) });
    body = await res.json();
  } catch {
    throw new Error("Telegram did not answer getMe");
  }
  if (!body?.ok || !body.result?.username) throw new Error(`Telegram rejected the token: ${body?.description || "unknown"}`);
  return body.result;
}

/** v1 files had a reply action per bot; anything but "off" meant listening. */
function migrate(cfg) {
  for (const b of cfg.bots || []) {
    if (b.reply) {
      b.listen = b.reply.action !== "off" && !b.owner;
      delete b.reply;
    }
    b.listen = !!b.listen;
  }
  cfg.routes ||= {};
  cfg.replies = { ...DEFAULT_REPLIES, ...cfg.replies };
  return cfg;
}

/** The config, created on first use from the bots already on this host. */
export async function loadComm({ env = process.env, fetchFn = fetch, known = KNOWN } = {}) {
  const existing = loadJson(commPath(env));
  if (existing) {
    // telegram.py reads the file as stored: write a migrated one back.
    const before = JSON.stringify(existing);
    const cfg = migrate(existing);
    if (JSON.stringify(cfg) !== before) atomicWriteJson(commPath(env), cfg);
    return cfg;
  }
  const cfg = { default: null, bots: [], routes: {}, replies: { ...DEFAULT_REPLIES } };
  for (const k of known) {
    if (!fs.existsSync(k.file)) continue;
    const token = readEnvFile(k.file).TELEGRAM_BOT_TOKEN;
    if (!token) continue;
    const me = await getMe(token, { fetchFn }).catch(() => null);
    const username = me?.username || path.basename(k.file, ".env");
    const id = username.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (cfg.bots.some((b) => b.id === id)) continue;
    cfg.bots.push({ id, username, env: k.file, imported: true, owner: k.owner, listen: false });
    if (k.isDefault) cfg.default = id;
  }
  cfg.default ||= cfg.bots[0]?.id || "bell";
  atomicWriteJson(commPath(env), cfg);
  return cfg;
}

const save = (cfg, env) => atomicWriteJson(commPath(env), cfg);
const botOf = (cfg, id) => {
  const bot = cfg.bots.find((b) => b.id === id);
  if (!bot) throw new Error(`unknown bot: ${id}`);
  return bot;
};
/** Every bot here talks to one person; a bot without a chat id uses another's. */
const anyChat = (cfg) => cfg.bots.map((b) => { try { return readEnvFile(b.env).TELEGRAM_CHAT_ID; } catch { return null; } }).find(Boolean);

/**
 * team-up and TIM jobs that send messages, plus your own jobs with notify on.
 * `group` is an id the page sorts by; title and notifies are in `lang`.
 */
export function listSenders({ env = process.env, exec = execFileSync, lang = "en" } = {}) {
  let crontab = "";
  try { crontab = readCrontab({ exec }); } catch { /* unreadable: shown as not scheduled */ }
  const state = (match) => {
    try { return findEntry(crontab, match); } catch { return null; }
  };
  const row = (group, key, title, notifies, match) => {
    const entry = match ? state(match) : null;
    return { group, key, title: t(lang, title), notifies: t(lang, notifies), scheduled: !match || !!entry, enabled: !match || !!entry?.enabled };
  };
  const out = [
    ...BUILTIN_JOBS.filter((j) => j.notifies).map((j) => row("team-up", senderKey(j.match), j.title, j.notifies, j.match)),
    ...TIM_SENDERS.map((s) => row("TIM", s.key, s.title, s.notifies, s.match)),
  ];
  const ini = cronJobsPath(env);
  const sections = fs.existsSync(ini) ? parseCronSections(fs.readFileSync(ini, "utf8")) : [];
  for (const s of sections) {
    if (s.values.custom !== "true" || s.values.notify !== "true") continue;
    out.push({ group: "Your jobs", key: s.name, title: s.name, notifies: s.values.description || t(lang, "Its result after every run."),
      scheduled: true, enabled: s.values.enabled !== "false" });
  }
  return out;
}

function readPollerStatus(env) {
  try { return loadJson(path.join(botDir(env), "poller.json")); } catch { return null; }
}

/** Claude models only: replies run `claude -p` (resume needs the same CLI). */
export const replyModelOptions = (modelOptions) => modelOptions.filter((m) => m.startsWith("claude:"));

export async function buildCommunicationView({ env = process.env, exec = execFileSync, fetchFn = fetch, modelOptions = [], lang = "en" } = {}) {
  const cfg = await loadComm({ env, fetchFn });
  const poller = readPollerStatus(env);

  const senders = listSenders({ env, exec, lang }).map((s) => ({ ...s, dest: cfg.routes[s.key] ?? null }));
  const jobs = (id) => senders.filter((s) => (s.dest ?? cfg.default) === id).length;
  const bots = cfg.bots.map((b) => {
    let tail = null;
    try {
      const token = readEnvFile(b.env).TELEGRAM_BOT_TOKEN;
      tail = token ? `…${token.slice(-4)}` : null;
    } catch { /* env file gone: shown as missing */ }
    return {
      id: b.id, username: b.username, env: tilde(b.env), imported: !!b.imported, owner: b.owner || null,
      tokenTail: tail, missing: tail === null, listen: !!b.listen, jobs: jobs(b.id), isDefault: cfg.default === b.id,
      poll: b.listen ? poller?.bots?.[b.id] ?? null : null,
    };
  });

  return {
    bots, senders, default: cfg.default,
    replies: { ...cfg.replies, cwd: tilde(cfg.replies.cwd) },
    modelOptions: replyModelOptions(modelOptions),
    pollerAt: poller?.at ?? null,
  };
}

export async function addBot({ token, chatId } = {}, { env = process.env, fetchFn = fetch } = {}) {
  const cfg = await loadComm({ env, fetchFn });
  token = String(token || "").trim();
  const me = await getMe(token, { fetchFn });
  const id = me.username.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (cfg.bots.some((b) => b.id === id)) throw new Error(`@${me.username} is already listed`);
  const chat = String(chatId || anyChat(cfg) || "").trim();
  if (!/^-?\d{1,20}$/.test(chat)) throw new Error("chat id: the numeric Telegram id the bot sends to");
  const file = path.join(botDir(env), `${id}.env`);
  atomicWriteText(file, `TELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_CHAT_ID=${chat}\n`, { mode: 0o600 });
  cfg.bots.push({ id, username: me.username, env: file, imported: false, owner: null, listen: false });
  cfg.default ||= id;
  save(cfg, env);
  return { id, username: me.username };
}

/** Imported bots leave the list only; their env file belongs to someone else. */
export async function removeBot(id, { env = process.env, fetchFn = fetch } = {}) {
  const cfg = await loadComm({ env, fetchFn });
  const bot = botOf(cfg, id);
  if (cfg.default === id) throw new Error("“Everything not listed” still goes to this bot; send it elsewhere first");
  const used = Object.entries(cfg.routes).filter(([, b]) => b === id).map(([k]) => k);
  if (used.length) throw new Error(`still carries ${used.join(", ")}; send those elsewhere first`);
  cfg.bots = cfg.bots.filter((b) => b.id !== id);
  save(cfg, env);
  if (!bot.imported) fs.rmSync(bot.env, { force: true });
  return { removed: id };
}

/**
 * Send `sender`'s messages to `dest`: a bot id or "bell". Sender "*" is
 * “Everything not listed”; `dest` null on a sender drops its own route.
 * `listed` are the senders the page shows: each one shows where it goes now,
 * so moving “everything else” pins them there first instead of moving them too.
 */
export async function setRoute(sender, dest, { env = process.env, fetchFn = fetch, listed = [] } = {}) {
  if (!SENDER.test(String(sender))) throw new Error("bad sender name");
  const cfg = await loadComm({ env, fetchFn });
  if (dest !== "bell" && dest !== null && dest !== "") botOf(cfg, dest);
  if (sender === "*") {
    if (!dest) throw new Error("everything not listed needs a destination");
    for (const key of listed) cfg.routes[key] ??= cfg.default;
    cfg.default = dest;
  } else if (!dest) {
    delete cfg.routes[sender];
  } else {
    cfg.routes[sender] = dest;
  }
  save(cfg, env);
  return {};
}

export async function setListen(id, listen, { env = process.env, fetchFn = fetch } = {}) {
  const cfg = await loadComm({ env, fetchFn });
  const bot = botOf(cfg, id);
  if (listen && bot.owner) {
    // Telegram hands each update to one getUpdates caller; a second poller
    // would steal replies from the owner (and fight it with 409s).
    throw new Error(`replies to @${bot.username} are read by ${bot.owner}`);
  }
  // A fresh offset makes the poller skip what queued up while it was not
  // listening, so switching back on never acts on stale messages.
  if (!!listen !== bot.listen) fs.rmSync(path.join(botDir(env), "offsets", id), { force: true });
  bot.listen = !!listen;
  save(cfg, env);
  return {};
}

export async function setReplies(input = {}, { env = process.env, fetchFn = fetch, modelOptions = [] } = {}) {
  const cfg = await loadComm({ env, fetchFn });
  if (!replyModelOptions(modelOptions).includes(input.model)) throw new Error("model: one of the claude models in the roster");
  const cwd = String(input.cwd || "").replace(/^~(?=\/|$)/, HOME);
  if (!path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("folder: an existing absolute path");
  }
  cfg.replies = { model: input.model, cwd, instructions: String(input.instructions || "").slice(0, 4000) };
  save(cfg, env);
  return {};
}

export async function sendTest(id, { env = process.env, fetchFn = fetch, lang = "en" } = {}) {
  const cfg = await loadComm({ env, fetchFn });
  const vars = readEnvFile(botOf(cfg, id).env);
  const res = await fetchFn(`https://api.telegram.org/bot${vars.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: vars.TELEGRAM_CHAT_ID || anyChat(cfg), text: t(lang, "Test from the team-up dashboard (Communication).") }),
    signal: AbortSignal.timeout(8000),
  }).then((r) => r.json()).catch(() => null);
  if (!res?.ok) throw new Error(`send failed: ${res?.description || "no answer"} — has the chat pressed Start on this bot?`);
  return {};
}
