// models-pty.mjs — interactive /model picker via expect (claude fallback, codex).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bashSingleQuote,
  claudeTrustBranch,
  dialogBranches,
  fastExitBlock,
  shellEscape,
  spawnLine,
  timeoutTail,
} from "../usage/pty-expect-core.mjs";
import {
  COLLECT_ENV,
  formatPtyTimeoutError,
  redactSecrets,
  shouldReturnPtyTranscript,
} from "../usage/usage-pty.mjs";

function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x1b\\]*(?:\x1b\\|\x07)/g, "");
}

function paneLines(text) {
  return stripAnsi(text).replace(/\r/g, "").split("\n");
}
import { tryAcquirePtyLock, releasePtyLock } from "../usage/usage-pty-lock.mjs";

/** Measured on host 2026-09-23 — codex /model picker title line. */
export const CODEX_MODEL_WAIT = "Select Model and Effort";

/** Status bar shows a real model name once boot finishes (not `loading`). */
export const CODEX_MODEL_READY = "GPT-6";
export const CODEX_MODEL_READY_ALT = "GPT-5";

/** Claude interactive picker or `claude -p /model` Available line. */
export const CLAUDE_MODEL_WAIT = "Available:";
export const CLAUDE_MODEL_WAIT_ALT = "Select a model";

const MODEL_SEQUENCES = {
  claude: {
    bin: "claude",
    ready: "Tip:",
    wait: CLAUDE_MODEL_WAIT,
    waitAlt: CLAUDE_MODEL_WAIT_ALT,
    exit: "/exit",
    cols: 120,
    rows: 40,
  },
  codex: {
    bin: "codex",
    ready: "Tip:",
    wait: CODEX_MODEL_WAIT,
    exit: "/exit",
    cols: 120,
    rows: 40,
  },
};

/**
 * Parse `claude -p /model` or interactive /model pane text.
 * @returns {Array<{ id: string, display_name: string, current?: true }>}
 */
export function parseClaudeModels(text) {
  const norm = stripAnsi(text).replace(/\r/g, "");
  const models = [];
  const avail = norm.match(/Available:\s*([^\n]+)/i);
  if (avail) {
    const tail = avail[1].replace(/\s+or a full model ID\.?$/i, "").replace(/\.\s*$/, "");
    for (const part of tail.split(/,\s*/)) {
      const id = part.trim();
      if (!id) continue;
      models.push({ id, display_name: id });
    }
    const cur = norm.match(/Current model:\s*`([^`]+)`/i);
    if (cur) {
      const label = cur[1].trim();
      const hit =
        models.find((m) => m.id.toLowerCase() === label.toLowerCase()) ||
        models.find((m) => label.toLowerCase().includes(m.id.toLowerCase()));
      if (hit) hit.current = true;
    }
    return models;
  }

  for (const line of norm.split("\n")) {
    const numbered = line.match(/^\s*(?:›\s*)?\d+\.\s+(.+?)(?:\s+\(current\))?\s*$/);
    if (numbered) {
      const display = numbered[1].trim();
      const current = /\(current\)/i.test(line);
      models.push({ id: display, display_name: display, ...(current ? { current: true } : {}) });
    }
  }
  return models;
}

/**
 * Parse codex /model picker pane (`Select Model and Effort` list).
 * @returns {Array<{ id: string, display_name: string, current?: true }>}
 */
function codexPaneNorm(text) {
  return stripAnsi(text)
    .replace(/\r/g, "")
    .replace(/\[[0-9]+;[0-9]+H/g, "\n")
    .replace(/(\d+\.)\s*\n\s*(GPT-)/g, "$1 $2");
}

/** The picker's label lowercased — the spelling codex and the roster use. */
export function codexModelId(display) {
  return String(display).trim().toLowerCase();
}

export function parseCodexModels(text) {
  const models = [];
  const seen = new Set();
  const norm = codexPaneNorm(text);
  for (const m of norm.matchAll(
    /(?:^|[\s›])\d+\.\s+(GPT-\d+(?:\.\d+)?(?:-[A-Z][a-z]+)?)(?:\s+\(current\))?/g
  )) {
    const display = m[1].trim();
    if (!display || seen.has(display)) continue;
    seen.add(display);
    models.push({
      // The picker prints a title-cased label ("GPT-6-Astra"); the id codex
      // actually accepts is its lowercase form, which is what the roster
      // sends. Keeping the label as the id made every roster cell read as
      // "gone" — and that list feeds a daily alert.
      id: codexModelId(display),
      display_name: display,
      ...( /\(current\)/i.test(m[0]) ? { current: true } : {}),
    });
  }
  if (models.length) return models;

  for (const line of norm.split("\n")) {
    const row = line.match(/^\s*(?:›\s*)?\d+\.\s+(.+?)(?:\s+\(current\))?\s*$/);
    if (!row) continue;
    const display = row[1].trim();
    if (!display || seen.has(display)) continue;
    seen.add(display);
    models.push({
      id: codexModelId(display),
      display_name: display,
      ...( /\(current\)/i.test(line) ? { current: true } : {}),
    });
  }
  return models;
}

export function buildModelExpectScript(cli, timeoutSec = 90) {
  const seq = MODEL_SEQUENCES[cli];
  if (!seq) throw new Error(`no model PTY sequence for cli: ${cli}`);
  const dialogs = dialogBranches(cli === "claude" ? claudeTrustBranch() : "");
  const bootTimeout = Math.max(60, Math.floor(timeoutSec * 0.6));
  const panelTimeout = Math.max(45, Math.floor(timeoutSec * 0.35));
  const readyPat = shellEscape(seq.ready || "Tip:");
  const waitPat = shellEscape(seq.wait);
  const waitAltPat = seq.waitAlt ? shellEscape(seq.waitAlt) : null;
  const exitCmd = shellEscape(seq.exit);
  const spawn = shellEscape(spawnLine(seq));

  if (cli === "codex") {
    const readyModelPat = shellEscape(CODEX_MODEL_READY);
    const readyModelAltPat = shellEscape(CODEX_MODEL_READY_ALT);
    const loadTimeout = Math.max(90, Math.floor(timeoutSec * 0.75));
    return `set timeout ${loadTimeout}
match_max 1000000
spawn bash -c "${spawn}"
expect {
${dialogs}  -re "${readyModelPat}" { }
  -re "${readyModelAltPat}" { }
  -re "${readyPat}" { }
  eof { exit 3 }
${timeoutTail()}}
send "/model\\r"
set timeout ${panelTimeout}
expect {
${dialogs}  -re "${waitPat}" { }
  timeout {
    send "/model\\r"
    expect {
${dialogs}      -re "${waitPat}" { }
${timeoutTail()}    }
  }
${timeoutTail()}}
catch { send "\\033" }
${fastExitBlock(exitCmd)}`;
  }

  const modelExpect = waitAltPat
    ? `expect {
${dialogs}  -re "${waitPat}" { }
  -re "${waitAltPat}" { }
${timeoutTail()}}`
    : `expect {
${dialogs}  -re "${waitPat}" { }
${timeoutTail()}}`;

  return `set timeout ${bootTimeout}
match_max 1000000
spawn bash -c "${spawn}"
expect {
${dialogs}  -re "${readyPat}" { }
  eof { exit 3 }
${timeoutTail()}}
send "/model\\r"
set timeout ${panelTimeout}
${modelExpect}
catch { send "\\033" }
${fastExitBlock(exitCmd)}`;
}

/**
 * @param {'claude'|'codex'} cli
 * @param {{ timeoutSec?: number }} [opts]
 * @returns {string} transcript
 */
export function runModelPtyCollect(cli, opts = {}) {
  const timeoutSec = opts.timeoutSec ?? 90;
  const script = buildModelExpectScript(cli, timeoutSec);
  const tmp = path.join(os.tmpdir(), `team-up-model-pty-${cli}-${process.pid}.exp`);
  fs.writeFileSync(tmp, script);
  try {
    const { TEAM_UP_USAGE_COLLECT, O9K_USAGE_COLLECT, ...parentEnv } = process.env;
    return execFileSync("expect", [tmp], {
      encoding: "utf8",
      env: { ...parentEnv, TERM: COLLECT_ENV.TERM },
      timeout: (timeoutSec + 30) * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    const stdout = typeof e?.stdout === "string" ? e.stdout : e?.stdout?.toString?.("utf8") || "";
    const stderr = typeof e?.stderr === "string" ? e.stderr : e?.stderr?.toString?.("utf8") || "";
    const combined = `${stdout}\n${stderr}`;
    if (/PTY_TIMEOUT_TAIL:/.test(combined) || e?.status === 2) {
      throw new Error(formatPtyTimeoutError(cli, stdout, stderr).replace("collect timed out", "model collect timed out"));
    }
    if (shouldReturnPtyTranscript({ status: e?.status, stdout, stderr, combined })) {
      return stdout;
    }
    throw new Error(redactSecrets(String(e?.message || e)));
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Run model PTY collect under the global PTY lock.
 * @template T
 * @param {'claude'|'codex'} cli
 * @param {{ timeoutSec?: number }} [opts]
 */
export function withModelPtyLock(cli, opts = {}) {
  if (!tryAcquirePtyLock()) {
    return { ok: false, reason: "pty-lock-contention" };
  }
  try {
    const transcript = runModelPtyCollect(cli, opts);
    return { ok: true, transcript };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  } finally {
    releasePtyLock();
  }
}
