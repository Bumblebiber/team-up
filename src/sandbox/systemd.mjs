import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Process-lifetime cache: only a successful semantic probe is stored. */
let _systemdAvailableCache = undefined;

export function resetSystemdAvailableCache() {
  _systemdAvailableCache = undefined;
}

/**
 * Create home sentinel + outside-home noexec artifacts for semantic probes.
 * Home hide and executable block must be independently observable.
 */
export function createProbeArtifacts() {
  const homeProbeDir = fs.mkdtempSync(path.join(os.homedir(), ".team-up-sandbox-probe-"));
  const noexecProbeDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-sandbox-noexec-"));
  const sentinel = path.join(homeProbeDir, "sentinel.txt");
  const noexecScript = path.join(noexecProbeDir, "noexec.sh");
  fs.writeFileSync(sentinel, "HOME_SHOULD_BE_HIDDEN\n", { mode: 0o600 });
  fs.writeFileSync(noexecScript, "#!/bin/sh\necho NOEXEC_RAN\n", { mode: 0o700 });
  fs.chmodSync(noexecScript, 0o700);
  return {
    homeProbeDir,
    noexecProbeDir,
    sentinel,
    noexecScript,
    cleanup() {
      for (const dir of [homeProbeDir, noexecProbeDir]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    },
  };
}

/** Evaluate raw probe stdout/stderr for independent home + noexec checks. */
export function evaluateProbeOutput(text) {
  const out = String(text);
  if (/HOME_VISIBLE/.test(out) || /NOEXEC_FAILED/.test(out)) return false;
  return /ENFORCEMENT_OK/.test(out);
}

/**
 * Semantic live probe: verify ProtectHome hides a home sentinel and
 * NoExecPaths/ExecPaths block executing a script outside ExecPaths (and
 * outside $HOME so hide alone cannot fake noexec success).
 * Caches only success for the process lifetime. Always cleans probe artifacts.
 */
export function systemdAvailable() {
  if (_systemdAvailableCache === true) return true;

  let artifacts = null;
  try {
    artifacts = createProbeArtifacts();
    const { sentinel, noexecScript } = artifacts;

    // /usr/bin/sh is allowed; the probe asserts home isolation + noexec semantics.
    const inner = [
      `if cat '${sentinel.replace(/'/g, `'\\''`)}' >/dev/null 2>&1; then echo HOME_VISIBLE; exit 0; fi`,
      `if '${noexecScript.replace(/'/g, `'\\''`)}' >/dev/null 2>&1; then echo NOEXEC_FAILED; exit 0; fi`,
      `echo ENFORCEMENT_OK`,
    ].join("; ");

    let out = "";
    try {
      out = execFileSync(
        "systemd-run",
        [
          "--user",
          "--wait",
          "--pipe",
          "-p",
          "ProtectHome=tmpfs",
          "-p",
          "NoExecPaths=/",
          "-p",
          "ExecPaths=/usr/bin",
          "/usr/bin/sh",
          "-c",
          inner,
        ],
        { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (e) {
      // Unit failure can still mean semantics work (e.g. noexec killed the unit).
      out = `${e.stdout || ""}${e.stderr || ""}${e.message || ""}`;
    }

    if (!evaluateProbeOutput(out)) {
      return false;
    }

    _systemdAvailableCache = true;
    return true;
  } catch {
    return false;
  } finally {
    if (artifacts) artifacts.cleanup();
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

/** Non-empty validated runtime path list counts as configured. */
export function isRuntimePathsConfigured(sandboxRuntimePaths) {
  return Array.isArray(sandboxRuntimePaths) && sandboxRuntimePaths.length > 0;
}

/**
 * Wrap a command with OS isolation when available.
 * `enforcement: "required"` (default) fails closed with SANDBOX_UNAVAILABLE.
 * `enforcement: "best_effort"` falls back to unsandboxed argv with an audit warning
 * for trusted specialist launches — not a security boundary.
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
  enforcement = "required",
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
    return { argv: command, sandbox: "none", enforced: false };
  }

  if (typeof probe !== "function" || !probe()) {
    if (enforcement === "best_effort") {
      return {
        argv: command,
        sandbox: "none",
        enforced: false,
        warning:
          "best-effort sandbox unavailable; trusted specialist runs without OS isolation",
      };
    }
    const err = new Error("SANDBOX_UNAVAILABLE: systemd-run --user cannot enforce requested permissions");
    err.code = "SANDBOX_UNAVAILABLE";
    throw err;
  }

  // filesystem:none must not bind or expose the project
  const effectiveProjectPath =
    permissions?.filesystem === "none" ? null : projectPath;

  const homeCli = cliPath && isUnderHome(cliPath);
  const runtimeConfigured = isRuntimePathsConfigured(sandboxRuntimePaths);
  if ((requireHomeRuntime || homeCli) && !runtimeConfigured) {
    const err = new Error(
      "SANDBOX_RUNTIME_UNAVAILABLE: home-installed CLI requires explicit non-empty sandbox_runtime_paths in roster clis.<cli>"
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
    enforced: true,
  };
}
