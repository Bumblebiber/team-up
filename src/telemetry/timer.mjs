import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sanitizeExecutablePath, unitQuote } from "../runs/gc-timer.mjs";

// A timer, not a daemon: nothing to supervise, and a sample that hangs on a
// stuck /proc read cannot hold up the next one.
export function renderTelemetryUnits({ nodePath, cliPath }) {
  const node = sanitizeExecutablePath(nodePath);
  const cli = sanitizeExecutablePath(cliPath);
  return {
    service: `[Unit]
Description=team-up resource sample

[Service]
Type=oneshot
ExecStart=${unitQuote(node)} ${unitQuote(cli)} telemetry sample
TimeoutStartSec=25s
`,
    timer: `[Unit]
Description=Sample machine load and team-up workers every 30 seconds

[Timer]
OnBootSec=30s
OnUnitActiveSec=30s
AccuracySec=5s
Unit=team-up-telemetry.service

[Install]
WantedBy=timers.target
`,
  };
}

export function installTelemetryTimer({
  home = os.homedir(),
  nodePath = process.execPath,
  cliPath = fileURLToPath(new URL("../../bin/team-up.mjs", import.meta.url)),
  exec = execFileSync,
} = {}) {
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(cliPath)) {
    throw new Error("telemetry timer requires absolute executable paths");
  }
  const dir = path.join(home, ".config", "systemd", "user");
  fs.mkdirSync(dir, { recursive: true });
  const servicePath = path.join(dir, "team-up-telemetry.service");
  const timerPath = path.join(dir, "team-up-telemetry.timer");
  const units = renderTelemetryUnits({ nodePath, cliPath });
  fs.writeFileSync(servicePath, units.service);
  fs.writeFileSync(timerPath, units.timer);
  exec("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  exec("systemctl", ["--user", "enable", "--now", "team-up-telemetry.timer"], { stdio: "ignore" });
  return { servicePath, timerPath };
}

/** Whether user timers keep running after logout. Null when it cannot be read. */
export function lingerEnabled({ user = os.userInfo().username, exec = execFileSync } = {}) {
  try {
    const raw = exec("loginctl", ["show-user", user, "-p", "Linger", "--value"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const value = String(raw).trim();
    return value === "yes" ? true : value === "no" ? false : null;
  } catch {
    return null;
  }
}
