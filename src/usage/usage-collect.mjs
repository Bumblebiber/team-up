// usage-collect.mjs — subscription usage collectors → ~/.team-up/usage.json

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseClaudeUsage, claudeParseComplete } from "../collectors/parse-claude-usage.mjs";
import { parseCodexStatus } from "../collectors/parse-codex-status.mjs";
import { parseCursorUsage } from "../collectors/parse-cursor-usage.mjs";
import { configPath, loadJson, usagePath } from "../roster/roster.mjs";
import { usageWritePath } from "../paths.mjs";
import { killCollectStrays } from "./usage-procs.mjs";
import { withPtyLock } from "./usage-pty-lock.mjs";
import { runPtyCollect, COLLECT_ENV } from "./usage-pty.mjs";
import { pushSample } from "./usage-windows.mjs";
import { fetchClaudeUsageJson, fetchCodexUsageJson } from "./usage-json.mjs";

const DEFAULT_SUBSCRIPTIONS = ["claude", "codex", "cursor"];

export function subscriptionsFromRoster(roster) {
  if (Array.isArray(roster?.subscriptions) && roster.subscriptions.length) {
    return roster.subscriptions;
  }
  return DEFAULT_SUBSCRIPTIONS;
}

export function isSubscriptionCli(cli, roster) {
  return subscriptionsFromRoster(roster || loadJson(configPath()) || {}).includes(cli);
}

export function mergeUsageWindows(existing, parsed) {
  const base = existing ? structuredClone(existing) : { windows: {}, marked: {} };
  base.windows = base.windows || {};
  base.marked = base.marked || {};
  const now = new Date().toISOString();
  for (const [key, info] of Object.entries(parsed)) {
    if (!info || typeof info.used !== "number") continue;
    const updated = info.updated || now;
    // The collectors rebuild each record from a fixed field list, so the
    // sample ring only survives if the merge carries it across explicitly.
    base.windows[key] = {
      ...info,
      updated,
      history: pushSample(base.windows[key]?.history, { used: info.used, at: updated }),
    };
  }
  base.updated = now;
  return base;
}

export function writeUsageAtomic(usageObj, dest = usageWritePath()) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(usageObj, null, 2)}\n`);
  fs.renameSync(tmp, dest);
}

function collectClaudeFast() {
  const text = execFileSync("claude", ["-p", "/usage"], {
    encoding: "utf8",
    env: { ...process.env, ...COLLECT_ENV },
    timeout: 45_000,
    maxBuffer: 2 * 1024 * 1024,
    // claude may be an npm .cmd shim on Windows — needs a shell there.
    shell: process.platform === "win32",
  });
  return parseClaudeUsage(text);
}

const AUTH_STATUS = {
  claude: ["claude", ["auth", "status"]],
  codex: ["codex", ["login", "status"]],
  cursor: ["cursor-agent", ["status"]],
};

/**
 * A logged-out TUI never says so on the collector's path: it sits on a login
 * screen the expect script does not know, and the collect ends as empty-parse
 * or a timeout. Each CLI's own status command does say so — claude as JSON
 * `"loggedIn": false` (exit 1), codex and cursor as a `Not logged in` line.
 * Asked only after a failed collect, so a healthy collect never pays for it.
 */
export function loggedOut(cli, run = spawnSync) {
  const [bin, args] = AUTH_STATUS[cli] || [];
  if (!bin) return false;
  const r = run(bin, args, {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  return /"loggedIn":\s*false|^\s*not logged in\b/im.test(`${r?.stdout || ""}\n${r?.stderr || ""}`);
}

function collectCliTranscript(cli) {
  if (cli === "claude") {
    let windows = collectClaudeFast();
    if (!claudeParseComplete(windows)) {
      const transcript = runPtyCollect("claude");
      windows = { ...windows, ...parseClaudeUsage(transcript) };
    }
    return windows;
  }
  if (cli === "codex") {
    return parseCodexStatus(runPtyCollect("codex"));
  }
  if (cli === "cursor") {
    return parseCursorUsage(runPtyCollect("cursor"));
  }
  throw new Error(`unknown cli: ${cli}`);
}

/**
 * @param {{ cli: string, roster?: object, dryRun?: boolean }} opts
 */
export async function collectUsageForCli(opts) {
  const { cli, dryRun = false } = opts;
  const roster = opts.roster || loadJson(configPath()) || {};
  if (!isSubscriptionCli(cli, roster)) {
    return { cli, ok: false, reason: "not-subscription" };
  }

  let jsonFallbackReason = null;
  if (cli === "claude" || cli === "codex") {
    let jsonResult;
    try {
      const collectJson = cli === "claude" ? fetchClaudeUsageJson : fetchCodexUsageJson;
      jsonResult = await collectJson({
        env: opts.env,
        homeDir: opts.homeDir,
        fileReader: opts.fileReader,
        fetchImpl: opts.fetchImpl,
        now: opts.now,
      });
    } catch {
      jsonResult = { ok: false, reason: "JSON usage collection failed" };
    }
    if (jsonResult?.ok && jsonResult.windows && Object.keys(jsonResult.windows).length > 0) {
      if (!dryRun) {
        const readUsage = opts.readUsage || (() => loadJson(usagePath()));
        const writeUsage = opts.writeUsage || ((usage) => writeUsageAtomic(usage));
        writeUsage(mergeUsageWindows(readUsage(), jsonResult.windows));
      }
      return { cli, ok: true, windows: jsonResult.windows };
    }
    jsonFallbackReason = jsonResult?.reason || "JSON usage produced no supported windows";
  }

  // A PTY collect boots a whole CLI: MCP servers included (the telegram plugin's
  // `bun`). Those outlive an expect that exits on `/exit` or on a boot
  // timeout, and pile up in the watcher's cgroup. Sweep inside the lock, so a
  // concurrent collect's tree is never the one being killed.
  let lock;
  try {
    if (opts.collectFallback) {
      lock = { ok: true, value: await opts.collectFallback(cli) };
    } else {
      lock = await withPtyLock(async () => {
        try {
          return collectCliTranscript(cli);
        } finally {
          killCollectStrays();
        }
      });
    }
  } catch (e) {
    if (loggedOut(cli)) {
      return {
        cli,
        ok: false,
        reason: jsonFallbackReason ? `JSON usage failed (${jsonFallbackReason}); PTY fallback: not logged in` : "not logged in",
      };
    }
    if (jsonFallbackReason) {
      return { cli, ok: false, reason: `JSON usage failed (${jsonFallbackReason}); PTY fallback failed` };
    }
    throw e;
  }
  if (!lock.ok) {
    const reason = "pty-lock-contention";
    return {
      cli,
      ok: false,
      reason: jsonFallbackReason ? `JSON usage failed (${jsonFallbackReason}); ${reason}` : reason,
    };
  }
  const parsed = lock.value;
  if (!parsed || !Object.keys(parsed).length) {
    const reason = loggedOut(cli) ? "not logged in" : "empty-parse";
    return {
      cli,
      ok: false,
      reason: jsonFallbackReason ? `JSON usage failed (${jsonFallbackReason}); PTY fallback: ${reason}` : reason,
    };
  }
  if (!dryRun) {
    const readUsage = opts.readUsage || (() => loadJson(usagePath()));
    const writeUsage = opts.writeUsage || ((usage) => writeUsageAtomic(usage));
    writeUsage(mergeUsageWindows(readUsage(), parsed));
  }
  return {
    cli,
    ok: true,
    windows: parsed,
    ...(jsonFallbackReason ? { reason: `JSON usage failed (${jsonFallbackReason}); used PTY fallback` } : {}),
  };
}

/**
 * @param {{ clis?: string[], roster?: object, dryRun?: boolean }} [opts]
 */
export async function collectUsage(opts = {}) {
  const roster = opts.roster || loadJson(configPath()) || {};
  const clis = opts.clis || subscriptionsFromRoster(roster);
  const results = [];
  for (const cli of clis) {
    try {
      results.push(await collectUsageForCli({ cli, roster, dryRun: opts.dryRun }));
    } catch (e) {
      results.push({ cli, ok: false, reason: String(e.message || e) });
    }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const cli = args.includes("--cli") ? args[args.indexOf("--cli") + 1] : null;
  const all = args.includes("--all");
  const dryRun = args.includes("--dry-run");

  if (!cli && !all) {
    console.error("usage: usage-collect.mjs --cli <claude|codex|cursor> | --all [--dry-run]");
    process.exit(1);
  }

  const roster = loadJson(configPath()) || {};
  const clis = cli ? [cli] : subscriptionsFromRoster(roster);
  const results = await collectUsage({ clis, roster, dryRun });

  for (const r of results) {
    if (r.ok) {
      console.log(`ok ${r.cli}: ${Object.keys(r.windows).join(", ")}`);
    } else {
      console.log(`skip ${r.cli}: ${r.reason}`);
    }
  }
  if (!results.some((r) => r.ok)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
