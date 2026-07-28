import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function unitQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderGcUnits({ nodePath, cliPath }) {
  return {
    service: `[Unit]
Description=team-up terminal and stale worker cleanup

[Service]
Type=oneshot
ExecStart=${unitQuote(nodePath)} ${unitQuote(cliPath)} runs gc
`,
    timer: `[Unit]
Description=Run team-up worker cleanup every five minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
Persistent=true
Unit=team-up-gc.service

[Install]
WantedBy=timers.target
`,
  };
}

export function installGcTimer({
  home = os.homedir(),
  nodePath = process.execPath,
  cliPath = fileURLToPath(new URL("../../bin/team-up.mjs", import.meta.url)),
  exec = execFileSync,
} = {}) {
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(cliPath)) {
    throw new Error("gc timer requires absolute executable paths");
  }
  const dir = path.join(home, ".config", "systemd", "user");
  fs.mkdirSync(dir, { recursive: true });
  const servicePath = path.join(dir, "team-up-gc.service");
  const timerPath = path.join(dir, "team-up-gc.timer");
  const units = renderGcUnits({ nodePath, cliPath });
  fs.writeFileSync(servicePath, units.service);
  fs.writeFileSync(timerPath, units.timer);
  exec("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  exec("systemctl", ["--user", "enable", "--now", "team-up-gc.timer"], { stdio: "ignore" });
  return { servicePath, timerPath };
}
