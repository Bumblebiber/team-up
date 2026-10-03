#!/usr/bin/env node
// limit-watch.mjs — hook entry: warn when usage crosses roster limits.
// Contract: silent + exit 0 in every failure mode.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadJson, configPath, usagePath } from "./config.mjs";
import { checkThresholds } from "./chain.mjs";
import { detectHostCli } from "../runs/parent.mjs";
import { debugLog } from "../debug.mjs";

const REFRESH_SCRIPT = fileURLToPath(new URL("../usage/usage-limit-refresh.mjs", import.meta.url));

function scheduleLimitRefresh(cli) {
  try {
    spawn(process.execPath, [REFRESH_SCRIPT, "--cli", cli], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch (e) {
    debugLog("team-up limit-watch schedule", e);
  }
}

/**
 * The CLI whose session runs this hook, or null. Only that CLI's windows can
 * end the session: an exhausted codex window says nothing about a Claude
 * session's quota. The Cursor CLI runs Claude Code hooks too, so the session
 * registry (written by the SessionStart hook) is asked rather than assuming
 * claude; before it exists, an ancestor CLAUDE_PID names claude. Unknown
 * checks every window.
 */
function hostCli() {
  try {
    return detectHostCli();
  } catch (e) {
    debugLog("team-up limit-watch host", e);
    return null;
  }
}

try {
  const roster = loadJson(configPath());
  if (roster) {
    let usage = null;
    try {
      usage = loadJson(usagePath());
    } catch (e) {
      debugLog("team-up limit-watch usage", e);
    }
    const result = checkThresholds({ roster, usage, hostCli: hostCli() });
    for (const cli of result.needsRefresh) {
      scheduleLimitRefresh(cli);
    }
    if (result.message) console.log(result.message);
  }
} catch (e) {
  debugLog("team-up limit-watch", e);
}
