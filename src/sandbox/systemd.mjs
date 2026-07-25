import { execFileSync } from "node:child_process";
import path from "node:path";

export function systemdAvailable() {
  try {
    execFileSync(
      "systemd-run",
      ["--user", "--wait", "--pipe", "-p", "ProtectSystem=strict", "-p", "PrivateTmp=yes", "true"],
      { stdio: "ignore", timeout: 10_000 }
    );
    return true;
  } catch {
    return false;
  }
}

function asPropList(paths) {
  return (paths || []).filter(Boolean).map((p) => path.resolve(p));
}

/**
 * Build systemd-run argv with fail-closed home isolation.
 * ProtectHome=tmpfs hides the rest of $HOME; only explicit binds are visible.
 */
export function systemdSandboxArgv({
  cwd,
  network,
  writablePaths = [],
  readOnlyPaths = [],
  command,
  callType,
  projectPath,
  packagePath,
  runPath,
  cliPath,
  extraReadOnly = [],
  extraReadWrite = [],
  writableProject = false,
}) {
  const ro = new Set(asPropList(readOnlyPaths));
  const rw = new Set(asPropList(writablePaths));

  if (packagePath) ro.add(path.resolve(packagePath));
  if (cliPath) ro.add(path.resolve(cliPath));
  if (runPath) rw.add(path.resolve(runPath));
  if (cwd) {
    // context dir is typically under runPath and writable for mailbox
    rw.add(path.resolve(cwd));
  }
  if (projectPath) {
    const proj = path.resolve(projectPath);
    if (writableProject && (callType === "delegate" || callType === undefined)) {
      rw.add(proj);
    } else {
      ro.add(proj);
    }
  }
  for (const p of extraReadOnly) ro.add(path.resolve(p));
  for (const p of extraReadWrite) rw.add(path.resolve(p));

  // Writable wins over read-only if both listed
  for (const p of rw) ro.delete(p);

  const properties = [
    "ProtectSystem=strict",
    "ProtectHome=tmpfs",
    "PrivateTmp=yes",
    "NoNewPrivileges=yes",
    `WorkingDirectory=${path.resolve(cwd || "/tmp")}`,
    `PrivateNetwork=${network ? "no" : "yes"}`,
  ];
  for (const p of ro) properties.push(`BindReadOnlyPaths=${p}`);
  for (const p of rw) properties.push(`BindPaths=${p}`);
  // Also keep ReadWritePaths for older systemd compatibility alongside BindPaths
  for (const p of rw) properties.push(`ReadWritePaths=${p}`);

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
 * Default probe is the real systemdAvailable — tests may inject probe.
 */
export function wrapWithSandbox({
  command,
  permissions,
  cwd,
  writablePaths = [],
  readOnlyPaths = [],
  callType,
  projectPath,
  packagePath,
  runPath,
  cliPath,
  writableProject,
  probe = systemdAvailable,
  ...rest
}) {
  const needsIsolation =
    permissions?.network === false ||
    permissions?.filesystem === "project" ||
    permissions?.filesystem === "project_readonly" ||
    permissions?.writes === false ||
    permissions?.writes === "delegated_only" ||
    permissions?.filesystem === "none";

  if (!needsIsolation) {
    return { argv: command, sandbox: "none" };
  }

  if (typeof probe !== "function" || !probe()) {
    const err = new Error("SANDBOX_UNAVAILABLE: systemd-run --user cannot enforce requested permissions");
    err.code = "SANDBOX_UNAVAILABLE";
    throw err;
  }

  const allowWritableProject =
    writableProject === true ||
    (writableProject !== false &&
      callType === "delegate" &&
      (permissions?.writes === "delegated_only" || permissions?.writes === true) &&
      permissions?.filesystem === "project");

  return {
    argv: systemdSandboxArgv({
      cwd,
      network: Boolean(permissions?.network),
      writablePaths,
      readOnlyPaths,
      command,
      callType,
      projectPath,
      packagePath,
      runPath,
      cliPath,
      writableProject: allowWritableProject,
      ...rest,
    }),
    sandbox: "systemd-run-user",
  };
}
