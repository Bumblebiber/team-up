// debug.mjs — TEAM_UP_DEBUG=1 (or the legacy O9K_DEBUG=1) makes swallowed
// hook errors visible, in <TEAM_UP_HOME>/logs/hook-errors.log.

import fs from "node:fs";
import path from "node:path";
import { debugLogDir } from "./paths.mjs";

export function debugLog(scope, err, env = process.env) {
  if (env.TEAM_UP_DEBUG !== "1" && env.O9K_DEBUG !== "1") return;
  try {
    const line = `${new Date().toISOString()} [${scope}] ${err?.stack || err}\n`;
    process.stderr.write(line);
    const dir = debugLogDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "hook-errors.log"), line);
  } catch {
    /* debug logging must never throw */
  }
}
