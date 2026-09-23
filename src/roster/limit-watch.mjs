#!/usr/bin/env node
// limit-watch.mjs — hook entry: warn when usage crosses roster limits.
// Contract: silent + exit 0 in every failure mode.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadJson, configPath, usagePath } from "./config.mjs";
import { checkThresholds } from "./chain.mjs";
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

try {
  const roster = loadJson(configPath());
  if (roster) {
    let usage = null;
    try {
      usage = loadJson(usagePath());
    } catch (e) {
      debugLog("team-up limit-watch usage", e);
    }
    const result = checkThresholds({ roster, usage });
    for (const cli of result.needsRefresh) {
      scheduleLimitRefresh(cli);
    }
    if (result.message) console.log(result.message);
  }
} catch (e) {
  debugLog("team-up limit-watch", e);
}
