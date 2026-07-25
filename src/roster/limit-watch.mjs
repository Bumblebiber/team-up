#!/usr/bin/env node
// limit-watch.mjs — hook entry: warn when usage crosses roster limits.
// Contract: silent + exit 0 in every failure mode.

import { loadJson, configPath, usagePath } from "./config.mjs";
import { checkThresholds } from "./chain.mjs";
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
    const out = checkThresholds({ roster, usage });
    if (out) console.log(out);
  }
} catch (e) {
  debugLog("team-up limit-watch", e);
}
