import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadJson } from "../json-store.mjs";

function writeClaudeJson(filePath, data) {
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
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
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

function resolveWorkspace(dir) {
  let workspace = path.resolve(dir);
  try {
    workspace = fs.realpathSync(workspace);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return workspace;
}

const PROJECT_TRUST_MARKERS = {
  hasTrustDialogAccepted: true,
  hasCompletedProjectOnboarding: true,
  projectOnboardingSeenCount: 1,
};

/**
 * Pre-accept Claude Code's workspace-trust gate for one dispatch cwd, the same
 * way agy gets an exact-path trustedWorkspaces entry before tmux starts.
 */
export function ensureClaudeWorkspaceTrusted(dir, { env = process.env } = {}) {
  const workspace = resolveWorkspace(dir);
  const home = env.HOME || os.homedir();
  const configPath = path.join(home, ".claude.json");
  const current = loadJson(configPath);
  if (current !== null && (typeof current !== "object" || Array.isArray(current))) {
    throw new TypeError(`claude config must be a JSON object: ${configPath}`);
  }

  const config = current ?? {};
  const projects = { ...(config.projects ?? {}) };
  const existing = projects[workspace] ?? {};
  if (
    existing.hasTrustDialogAccepted === true
    && existing.hasCompletedProjectOnboarding === true
  ) {
    return { configPath, workspace, changed: false };
  }

  projects[workspace] = { ...existing, ...PROJECT_TRUST_MARKERS };
  writeClaudeJson(configPath, { ...config, projects });
  return { configPath, workspace, changed: true };
}
