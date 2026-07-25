import { execFileSync } from "node:child_process";

export function systemdAvailable() {
  try {
    execFileSync("systemd-run", ["--user", "--wait", "--pipe", "true"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function systemdSandboxArgv({ cwd, network, writablePaths = [], command }) {
  const properties = [
    "ProtectSystem=strict",
    "PrivateTmp=yes",
    "NoNewPrivileges=yes",
    `WorkingDirectory=${cwd}`,
    `PrivateNetwork=${network ? "no" : "yes"}`,
  ];
  for (const p of writablePaths) properties.push(`ReadWritePaths=${p}`);
  return [
    "systemd-run",
    "--user",
    "--wait",
    "--collect",
    "--pipe",
    ...properties.flatMap((p) => ["-p", p]),
    "--",
    ...command,
  ];
}

/**
 * Fail-closed: if requested restrictions cannot be enforced, throw SANDBOX_UNAVAILABLE.
 */
export function wrapWithSandbox({ command, permissions, cwd, writablePaths = [], probe = systemdAvailable }) {
  const needsIsolation =
    permissions?.network === false ||
    permissions?.filesystem === "project" ||
    permissions?.filesystem === "project_readonly" ||
    permissions?.writes === false ||
    permissions?.writes === "delegated_only";

  if (!needsIsolation) {
    return { argv: command, sandbox: "none" };
  }

  if (!probe()) {
    const err = new Error("SANDBOX_UNAVAILABLE: systemd-run --user cannot enforce requested permissions");
    err.code = "SANDBOX_UNAVAILABLE";
    throw err;
  }

  return {
    argv: systemdSandboxArgv({
      cwd,
      network: Boolean(permissions?.network),
      writablePaths,
      command,
    }),
    sandbox: "systemd-run-user",
  };
}
