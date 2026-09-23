import { execFileSync, spawnSync } from "node:child_process";
import { harnessStatus } from "../harness/registry.mjs";
import { enrichCliRow } from "./installers.mjs";

export function commandExists(cmd, { exec = execFileSync } = {}) {
  if (!cmd || typeof cmd !== "string") return null;
  try {
    const result = spawnSync("bash", ["-c", 'command -v -- "$1"', "command-v", cmd], {
      encoding: "utf8",
    });
    const out = (result.stdout || "").trim();
    return out || null;
  } catch {
    return null;
  }
}

export function cliVersion(cli, { exec = execFileSync, env = process.env } = {}) {
  try {
    const status = harnessStatus(cli, { execFileSync: exec, env });
    return status.installed_version;
  } catch {
    return null;
  }
}

export function harnessLabel(status) {
  if (!status) return "unknown";
  if (status.status === "failed") return "installed, capabilities denied";
  if (status.status === "unsupported") return status.status;
  if (status.status === "not_installed") return "not installed";
  return status.status;
}

export function detectClis(roster, { exec = execFileSync, env = process.env } = {}) {
  const rows = [];
  for (const cli of Object.keys(roster?.clis || {}).sort()) {
    const spec = roster.clis[cli];
    const binary = Array.isArray(spec?.cmd) ? spec.cmd[0] : null;
    const pathFound = binary ? commandExists(binary, { exec }) : null;
    let harness = null;
    try {
      harness = harnessStatus(cli, { execFileSync: exec, env });
    } catch {
      harness = { cli, status: "unsupported", installed_version: null };
    }
    rows.push({
      cli,
      binary,
      present: !!pathFound,
      path: pathFound,
      version: harness?.installed_version ?? cliVersion(cli, { exec, env }),
      harness,
      harness_label: harnessLabel(harness),
    });
  }
  return { clis: rows };
}

export function buildClisView(roster, opts = {}) {
  const { allowInstall = false, env = process.env, ...detectOpts } = opts;
  const detected = detectClis(roster, detectOpts);
  return {
    clis: detected.clis.map((row) => enrichCliRow(row, roster, { allowInstall, env })),
  };
}
