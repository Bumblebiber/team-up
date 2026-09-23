#!/usr/bin/env node
// limit-watch.mjs — hook entry: warn when usage crosses roster limits.
// Contract: silent + exit 0 in every failure mode.

import { loadJson, configPath, usagePath } from "./config.mjs";
import { checkThresholdsWithRefresh } from "./chain.mjs";
import { debugLog } from "../debug.mjs";

try {
  const roster = loadJson(configPath());
  if (roster) {
    let usage = null;
    try {
      usage = loadJson(usagePath());
    } catch (e) {
      debugLog("team-up limit-watch usage", e);
    }
    const collectCli = async (cli) => {
      const { collectUsageForCli } = await import("../usage/usage-collect.mjs");
      return collectUsageForCli({ cli, roster });
    };
    const result = await checkThresholdsWithRefresh({
      roster,
      usage,
      collectCli,
      readUsage: () => loadJson(usagePath()),
    });
    if (result.message) console.log(result.message);
  }
} catch (e) {
  debugLog("team-up limit-watch", e);
}
