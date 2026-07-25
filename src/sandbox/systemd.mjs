import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

function validateBindPath(p, label = "bind path") {
  if (!p || typeof p !== "string") {
    const err = new Error(`SANDBOX_RUNTIME_UNAVAILABLE: invalid ${label}`);
    err.code = "SANDBOX_RUNTIME_UNAVAILABLE";
    throw err;
  }
  const resolved = path.resolve(p);
  if (!fs.existsSync(resolved)) {
    const err = new Error(`SANDBOX_RUNTIME_UNAVAILABLE: missing ${label}: ${resolved}`);
    err.code = "SANDBOX_RUNTIME_UNAVAILABLE";
    throw err;
  }
  return resolved;
}

/**
 * Build systemd-run argv with fail-closed home isolation.
 * ProtectHome=tmpfs hides the rest of $HOME; only explicit binds are visible.
 * NoExecPaths=/ + ExecPaths= deny execution except listed trees.
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
  execPaths = [],
}) {
  const ro = new Set(asPropList(readOnlyPaths));
  const rw = new Set(asPropList(writablePaths));

  if (packagePath) ro.add(path.resolve(packagePath));
  if (cliPath) ro.add(path.resolve(cliPath));
  if (runPath) rw.add(path.resolve(runPath));
  if (cwd) {
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

  const execList = new Set(asPropList(execPaths));
  if (cliPath) {
    // Allow executing the CLI binary and its parent directory tree
    execList.add(path.resolve(cliPath));
    execList.add(path.dirname(path.resolve(cliPath)));
  }
  // Always allow the resolved command argv0 tree
  if (command?.[0]) {
    const cmd0 = path.resolve(command[0]);
    execList.add(cmd0);
    execList.add(path.dirname(cmd0));
  }

  const properties = [
    "ProtectSystem=strict",
    "ProtectHome=tmpfs",
    "PrivateTmp=yes",
    "NoNewPrivileges=yes",
    "NoExecPaths=/",
    `ExecPaths=${[...execList].join(":")}`,
    `WorkingDirectory=${path.resolve(cwd || "/tmp")}`,
    `PrivateNetwork=${network ? "no" : "yes"}`,
  ];
  for (const p of ro) properties.push(`BindReadOnlyPaths=${p}`);
  for (const p of rw) properties.push(`BindPaths=${p}`);
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

function isUnderHome(p) {
  const home = os.homedir();
  const resolved = path.resolve(p);
  return resolved === home || resolved.startsWith(home + path.sep);
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
  sandboxRuntimePaths,
  requireHomeRuntime = false,
  execPaths = [],
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

  // filesystem:none must not bind or expose the project
  const effectiveProjectPath =
    permissions?.filesystem === "none" ? null : projectPath;

  const homeCli = cliPath && isUnderHome(cliPath);
  const runtimeConfigured = Array.isArray(sandboxRuntimePaths);
  if ((requireHomeRuntime || homeCli) && !runtimeConfigured) {
    const err = new Error(
      "SANDBOX_RUNTIME_UNAVAILABLE: home-installed CLI requires explicit sandbox_runtime_paths in roster clis.<cli>"
    );
    err.code = "SANDBOX_RUNTIME_UNAVAILABLE";
    throw err;
  }

  const extraRo = [...(readOnlyPaths || [])];
  const exec = [...execPaths];
  if (runtimeConfigured) {
    for (const p of sandboxRuntimePaths) {
      const resolved = validateBindPath(p, "sandbox_runtime_paths entry");
      extraRo.push(resolved);
      exec.push(resolved);
    }
  }
  if (cliPath) {
    try {
      validateBindPath(cliPath, "cliPath");
    } catch (e) {
      if (homeCli || requireHomeRuntime) throw e;
      // Non-home missing CLI path: still surface as runtime unavailable when isolation needs the binary
      if (e.code === "SANDBOX_RUNTIME_UNAVAILABLE") throw e;
    }
  }

  const allowWritableProject =
    effectiveProjectPath &&
    (writableProject === true ||
      (writableProject !== false &&
        callType === "delegate" &&
        (permissions?.writes === "delegated_only" || permissions?.writes === true) &&
        permissions?.filesystem === "project"));

  return {
    argv: systemdSandboxArgv({
      cwd,
      network: Boolean(permissions?.network),
      writablePaths,
      readOnlyPaths: extraRo,
      command,
      callType,
      projectPath: effectiveProjectPath,
      packagePath,
      runPath,
      cliPath,
      writableProject: Boolean(allowWritableProject),
      execPaths: exec,
      ...rest,
    }),
    sandbox: "systemd-run-user",
  };
}
