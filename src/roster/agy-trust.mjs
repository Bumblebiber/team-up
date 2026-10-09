import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadJson } from "../json-store.mjs";

function writeSettings(filePath, settings) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let renamed = false;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

/** Add one interactive agy workspace to its exact-path trust list. */
export function ensureAgyWorkspaceTrusted(dir, { env = process.env } = {}) {
  let workspace = path.resolve(dir);
  try {
    workspace = fs.realpathSync(workspace);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const home = env.HOME || os.homedir();
  const settingsPath = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  const current = loadJson(settingsPath);
  if (current !== null && (typeof current !== "object" || Array.isArray(current))) {
    throw new TypeError(`agy settings must be a JSON object: ${settingsPath}`);
  }

  const settings = current ?? {};
  const trustedWorkspaces = settings.trustedWorkspaces ?? [];
  if (!Array.isArray(trustedWorkspaces)) {
    throw new TypeError(`agy trustedWorkspaces must be an array: ${settingsPath}`);
  }
  if (trustedWorkspaces.includes(workspace)) return { settingsPath, workspace, changed: false };

  writeSettings(settingsPath, {
    ...settings,
    trustedWorkspaces: [...trustedWorkspaces, workspace],
  });
  return { settingsPath, workspace, changed: true };
}
