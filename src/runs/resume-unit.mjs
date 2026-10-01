import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sanitizeExecutablePath, unitQuote } from "./gc-timer.mjs";

export const RESUME_UNIT = "team-up-resume.service";

/**
 * Runs `runs resume --boot` once per boot. The resume works through its queue
 * one start at a time (plan 3), which can take many minutes, so the unit is
 * Type=simple: systemctl and the boot do not wait for it, and no start timeout
 * cuts it off. RemainAfterExit keeps the unit active once it returns, so the
 * tmux server it may have started stays alive instead of being killed with
 * the unit's cgroup. PATH is the installer's: a user unit's default PATH finds
 * neither tmux's CLIs nor node.
 */
export function renderResumeUnit({ nodePath, cliPath, envPath, teamUpHome = null }) {
  const node = sanitizeExecutablePath(nodePath);
  const cli = sanitizeExecutablePath(cliPath);
  const env = [`Environment=${unitQuote(`PATH=${sanitizeExecutablePath(envPath)}`)}`];
  if (teamUpHome) env.push(`Environment=${unitQuote(`TEAM_UP_HOME=${sanitizeExecutablePath(teamUpHome)}`)}`);
  return `[Unit]
Description=Resume team-up runs and their parent sessions after boot

[Service]
Type=simple
RemainAfterExit=yes
${env.join("\n")}
# Let the network and the user manager settle first.
ExecStartPre=/bin/sleep 20
ExecStart=${unitQuote(node)} ${unitQuote(cli)} runs resume --boot
TimeoutStartSec=infinity

[Install]
WantedBy=default.target
`;
}

export function installResumeUnit({
  home = os.homedir(),
  nodePath = process.execPath,
  cliPath = fileURLToPath(new URL("../../bin/team-up.mjs", import.meta.url)),
  envPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  teamUpHome = process.env.TEAM_UP_HOME ?? null,
  exec = execFileSync,
} = {}) {
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(cliPath)) {
    throw new Error("resume unit requires absolute executable paths");
  }
  const dir = path.join(home, ".config", "systemd", "user");
  fs.mkdirSync(dir, { recursive: true });
  const servicePath = path.join(dir, RESUME_UNIT);
  fs.writeFileSync(servicePath, renderResumeUnit({ nodePath, cliPath, envPath, teamUpHome }));
  exec("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  // enable, not --now: it is a boot action, and running it now would resume
  // whatever is in flight in the middle of a working session.
  exec("systemctl", ["--user", "enable", RESUME_UNIT], { stdio: "ignore" });
  return { servicePath };
}
