// Communication: which Telegram bot carries which cron job's messages, and
// what happens when Benni replies to a bot.
//
// ~/.team-up/communication.json holds the bots (each one an env file in the
// format ~/.hermes/bin/send-telegram reads), a route per sender and a reply
// action per bot. Tokens never leave their env file: views show @username and
// the last four characters only.
//
// Sending: ~/.hermes/bin/send-cron-telegram asks scripts/telegram-route.py
// which env file to use for the calling script; no config, an unknown sender
// or a removed bot all fall back to the default bot (CronBot, as before).
// Replies: scripts/telegram-replies.py (team-up-telegram-replies.service)
// polls only the bots whose reply action is not "off".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadJson, atomicWriteJson, atomicWriteText } from "../json-store.mjs";
import { teamUpHome } from "../paths.mjs";
import { BUILTIN_JOBS, RUNNER } from "./automation.mjs";
import { cronEntries, readCrontab } from "./crontab.mjs";
import { cronJobsPath, parseCronSections } from "./cron-jobs.mjs";

const HOME = os.homedir();
const tilde = (p) => p.replace(HOME, "~");
export const commPath = (env = process.env) => path.join(teamUpHome(env), "communication.json");
export const botDir = (env = process.env) => path.join(teamUpHome(env), "telegram");
export const REPLY_ACTIONS = ["off", "bell", "run"];
const BOT_ID = /^[a-z0-9_]{1,64}$/;
const SENDER = /^[A-Za-z0-9._-]{1,64}$/;

/** Bots that existed before this page. Another process owns their getUpdates. */
const KNOWN = [
  { file: path.join(HOME, ".hermes/secrets/cron-telegram.env"), owner: null, isDefault: true },
  { file: path.join(HOME, ".hermes/secrets/telegram.env"), owner: "reminderbot-guard.sh (reminders)" },
  { file: path.join(HOME, ".claude/channels/telegram/.env"), owner: "Claude Code telegram plugin" },
];

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

/** The config, created on first use from the bots already on this host. */
export async function loadComm({ env = process.env, fetchFn = fetch, known = KNOWN } = {}) {
  const existing = loadJson(commPath(env));
  if (existing) return existing;
  const cfg = { default: null, bots: [], routes: {} };
  for (const k of known) {
    if (!fs.existsSync(k.file)) continue;
    const token = readEnvFile(k.file).TELEGRAM_BOT_TOKEN;
    if (!token) continue;
    const me = await getMe(token, { fetchFn }).catch(() => null);
    const username = me?.username || path.basename(k.file, ".env");
    const id = username.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (cfg.bots.some((b) => b.id === id)) continue;
    cfg.bots.push({ id, username, env: k.file, imported: true, owner: k.owner, reply: { action: "off" } });
    if (k.isDefault) cfg.default = id;
  }
  if (!cfg.default && cfg.bots[0]) cfg.default = cfg.bots[0].id;
  atomicWriteJson(commPath(env), cfg);
  return cfg;
}

/** Every bot here talks to one person; a bot without a chat id uses another's. */
const anyChat = (cfg) => cfg.bots.map((b) => { try { return readEnvFile(b.env).TELEGRAM_CHAT_ID; } catch { return null; } }).find(Boolean);
const save = (cfg, env) => atomicWriteJson(commPath(env), cfg);
const botOf = (cfg, id) => {
  const bot = cfg.bots.find((b) => b.id === id);
  if (!bot) throw new Error(`unknown bot: ${id}`);
  return bot;
};

/** Names for senders that are not team-up built-in jobs. */
const TITLES = {
  "check-usage-wrapper": "Usage & balance check",
  "tim-db-header-watchdog": "TIM DB header watchdog",
  "tim-snapshot-watchdog": "TIM snapshot watchdog",
  "tim-wal-watchdog": "TIM WAL watchdog",
  "worker-reaper": "Worker reaper",
  "triage-report": "Triage report",
};

/** Crontab scripts that call send-cron-telegram, plus custom jobs that notify. */
export function listSenders({ env = process.env, exec = execFileSync } = {}) {
  let crontab = "";
  try { crontab = readCrontab({ exec }); } catch { /* no crontab: no senders */ }
  const senders = new Map();
  for (const e of cronEntries(crontab)) {
    const script = e.command.split(/\s+/).map((t) => t.replace(/^~|^\$HOME/, HOME)).find((t) => /\.(sh|py)$/.test(t));
    if (!script || script === RUNNER) continue;
    let text = "";
    try { text = fs.readFileSync(script, "utf8"); } catch { continue; }
    if (!text.includes("send-cron-telegram")) continue;
    const key = path.basename(script).replace(/\.(sh|py)$/, "");
    const builtin = BUILTIN_JOBS.find((j) => path.basename(j.match).replace(/\.(sh|py)$/, "") === key);
    senders.set(key, { key, title: builtin?.title || TITLES[key] || key, script: tilde(script), enabled: e.enabled });
  }
  const ini = cronJobsPath(env);
  const sections = fs.existsSync(ini) ? parseCronSections(fs.readFileSync(ini, "utf8")) : [];
  for (const s of sections) {
    if (s.values.custom !== "true" || s.values.notify !== "true") continue;
    senders.set(s.name, { key: s.name, title: `Custom job: ${s.name}`, script: null, enabled: s.values.enabled !== "false" });
  }
  return [...senders.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function readPollerStatus(env) {
  try { return loadJson(path.join(botDir(env), "poller.json")); } catch { return null; }
}

export async function buildCommunicationView({ env = process.env, exec = execFileSync, fetchFn = fetch, modelOptions = [] } = {}) {
  const cfg = await loadComm({ env, fetchFn });
  const poller = readPollerStatus(env);
  const bots = cfg.bots.map((b) => {
    let tail = null;
    let chat = null;
    try {
      const vars = readEnvFile(b.env);
      tail = vars.TELEGRAM_BOT_TOKEN ? `…${vars.TELEGRAM_BOT_TOKEN.slice(-4)}` : null;
      chat = vars.TELEGRAM_CHAT_ID || null;
    } catch { /* env file gone: shown as missing */ }
    return {
      id: b.id, username: b.username, env: tilde(b.env), imported: !!b.imported, owner: b.owner || null,
      tokenTail: tail, chatId: chat, missing: tail === null, isDefault: cfg.default === b.id,
      reply: b.reply || { action: "off" }, poll: poller?.bots?.[b.id] ?? null,
    };
  });
  const senders = listSenders({ env, exec }).map((s) => ({ ...s, bot: cfg.routes[s.key] ?? null }));
  return { bots, senders, default: cfg.default, modelOptions, pollerAt: poller?.at ?? null };
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
  cfg.bots.push({ id, username: me.username, env: file, imported: false, owner: null, reply: { action: "off" } });
  if (!cfg.default) cfg.default = id;
  save(cfg, env);
  return { id, username: me.username };
}

/** Imported bots leave the list only; their env file belongs to someone else. */
export async function removeBot(id, { env = process.env, fetchFn = fetch } = {}) {
  const cfg = await loadComm({ env, fetchFn });
  const bot = botOf(cfg, id);
  if (cfg.default === id) throw new Error("this is the default bot; make another one the default first");
  const used = Object.entries(cfg.routes).filter(([, b]) => b === id).map(([k]) => k);
  if (used.length) throw new Error(`still carries ${used.join(", ")}; route those elsewhere first`);
  cfg.bots = cfg.bots.filter((b) => b.id !== id);
  save(cfg, env);
  if (!bot.imported) fs.rmSync(bot.env, { force: true });
  return { removed: id, tokenTail: null };
}

export async function setDefaultBot(id, { env = process.env, fetchFn = fetch } = {}) {
  const cfg = await loadComm({ env, fetchFn });
  botOf(cfg, id);
  cfg.default = id;
  save(cfg, env);
  return {};
}

/** `bot` null sends the sender's messages through the default bot again. */
export async function setRoute(sender, bot, { env = process.env, fetchFn = fetch } = {}) {
  if (!SENDER.test(String(sender))) throw new Error("bad sender name");
  const cfg = await loadComm({ env, fetchFn });
  if (bot === null || bot === "") delete cfg.routes[sender];
  else cfg.routes[sender] = botOf(cfg, bot).id;
  save(cfg, env);
  return {};
}

export async function setReply(id, input = {}, { env = process.env, fetchFn = fetch, modelOptions = [] } = {}) {
  const cfg = await loadComm({ env, fetchFn });
  const bot = botOf(cfg, id);
  const action = String(input.action || "off");
  if (!REPLY_ACTIONS.includes(action)) throw new Error(`action: ${REPLY_ACTIONS.join(", ")}`);
  if (action !== "off" && bot.owner) {
    // Telegram hands each update to one getUpdates caller; a second poller
    // would steal replies from the owner (and fight it with 409s).
    throw new Error(`replies to @${bot.username} are handled by ${bot.owner}`);
  }
  const reply = { action };
  if (action === "run") {
    if (!modelOptions.includes(input.model)) throw new Error("model is not an available CLI:model option");
    const cwd = String(input.cwd || "").replace(/^~(?=\/|$)/, HOME);
    if (!path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("working directory: an existing absolute path");
    }
    reply.model = input.model;
    reply.cwd = cwd;
    reply.instructions = String(input.instructions || "").slice(0, 4000);
  }
  // A fresh offset makes the poller skip what queued up while it was not
  // listening, so switching replies back on never acts on stale messages.
  if (action !== (bot.reply?.action || "off")) fs.rmSync(path.join(botDir(env), "offsets", id), { force: true });
  bot.reply = reply;
  save(cfg, env);
  return {};
}

export async function sendTest(id, { env = process.env, fetchFn = fetch } = {}) {
  const cfg = await loadComm({ env, fetchFn });
  const vars = readEnvFile(botOf(cfg, id).env);
  const res = await fetchFn(`https://api.telegram.org/bot${vars.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: vars.TELEGRAM_CHAT_ID || anyChat(cfg), text: "Test from the team-up dashboard (Communication)." }),
    signal: AbortSignal.timeout(8000),
  }).then((r) => r.json()).catch(() => null);
  if (!res?.ok) throw new Error(`send failed: ${res?.description || "no answer"} — has the chat pressed Start on this bot?`);
  return {};
}
