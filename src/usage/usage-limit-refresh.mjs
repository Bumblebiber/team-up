#!/usr/bin/env node
// usage-limit-refresh.mjs — detached usage refresh for limit-watch hook.
// Re-spawns itself with --collect so the UserPromptSubmit hook returns
// immediately (5s timeout) instead of awaiting a 27–110s PTY collect.
// Contract: silent + exit 0 always.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { debugLog } from "../debug.mjs";

function cliArg() {
  const i = process.argv.indexOf("--cli");
  return i >= 0 ? process.argv[i + 1] : null;
}

async function runCollect(cli) {
  const { collectUsageForCli } = await import("./usage-collect.mjs");
  await collectUsageForCli({ cli });
}

try {
  if (process.env.TEAM_UP_USAGE_COLLECT === "1" || process.env.O9K_USAGE_COLLECT === "1") {
    process.exit(0);
  }

  const cli = cliArg();
  if (!cli) process.exit(0);

  if (process.argv.includes("--collect")) {
    await runCollect(cli);
    process.exit(0);
  }

  const self = fileURLToPath(import.meta.url);
  spawn(process.execPath, [self, "--collect", "--cli", cli], {
    detached: true,
    stdio: "ignore",
  }).unref();
} catch (e) {
  debugLog("team-up usage-limit-refresh", e);
}
