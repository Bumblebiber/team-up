// usage-collect.mjs — subscription usage collectors → ~/.team-up/usage.json

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCursorUsage } from "../collectors/parse-cursor-usage.mjs";
import { configPath, loadJson, usagePath } from "../roster/roster.mjs";
import { usageWritePath } from "../paths.mjs";
import { killCollectStrays } from "./usage-procs.mjs";
import { withPtyLock } from "./usage-pty-lock.mjs";
import { runPtyCollect, COLLECT_ENV } from "./usage-pty.mjs";
import { pushSample } from "./usage-windows.mjs";
import { fetchAgyUsageJson, fetchClaudeUsageJson, fetchCodexUsageJson } from "./usage-json.mjs";

// agy is opt-in through roster.subscriptions: a machine without it would log a failed collect every tick.
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
    const scope = info.scope ?? base.windows[key]?.scope;
    base.windows[key] = {
      ...info,
      ...(scope ? { scope } : {}),
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

function collectCursorTranscript() {
  return parseCursorUsage(runPtyCollect("cursor"));
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

  if (cli === "claude" || cli === "codex" || cli === "agy") {
    let jsonResult;
    try {
      if (cli === "agy") {
        jsonResult = fetchAgyUsageJson({
          run: opts.runAgy,
          env: { ...(opts.env || process.env), ...COLLECT_ENV },
          now: opts.now,
        });
      } else {
        const collectJson = cli === "claude" ? fetchClaudeUsageJson : fetchCodexUsageJson;
        jsonResult = await collectJson({
          env: opts.env,
          homeDir: opts.homeDir,
          fileReader: opts.fileReader,
          fetchImpl: opts.fetchImpl,
          now: opts.now,
        });
      }
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
    const reason = jsonResult?.reason || "JSON usage produced no supported windows";
    // No PTY fallback: leave existing windows untouched so they age out as stale.
    return { cli, ok: false, reason };
  }

  // Cursor has no JSON source — boot the TUI under the PTY lock.
  let lock;
  try {
    if (opts.collectFallback) {
      lock = { ok: true, value: await opts.collectFallback(cli) };
    } else {
      lock = await withPtyLock(async () => {
        try {
          return collectCursorTranscript();
        } finally {
          killCollectStrays();
        }
      });
    }
  } catch (e) {
    if ((opts.loggedOut || loggedOut)(cli)) {
      return { cli, ok: false, reason: "not logged in" };
    }
    throw e;
  }
  if (!lock.ok) {
    return { cli, ok: false, reason: "pty-lock-contention" };
  }
  const parsed = lock.value;
  if (!parsed || !Object.keys(parsed).length) {
    const reason = (opts.loggedOut || loggedOut)(cli) ? "not logged in" : "empty-parse";
    return { cli, ok: false, reason };
  }
  if (!dryRun) {
    const readUsage = opts.readUsage || (() => loadJson(usagePath()));
    const writeUsage = opts.writeUsage || ((usage) => writeUsageAtomic(usage));
    writeUsage(mergeUsageWindows(readUsage(), parsed));
  }
  return { cli, ok: true, windows: parsed };
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
    console.error("usage: usage-collect.mjs --cli <claude|codex|cursor|agy> | --all [--dry-run]");
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
