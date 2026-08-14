import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadState, saveState, setStatus } from "../runs/runs.mjs";
import { buildCommand, tmuxArgs } from "../roster/command.mjs";
import { requireRoster, loadJson, usagePath } from "../roster/config.mjs";
import { prepareHarnessLaunch } from "../harness/registry.mjs";
import { wrapWithSandbox, systemdAvailable } from "../sandbox/systemd.mjs";
import { buildStrictMcpConfig } from "../capabilities/capsule.mjs";
import { launchDescriptorDir } from "../paths.mjs";
import {
  acquireAttemptLease,
  releaseAttemptLease,
  transferLeaseOwner,
  createAttempt,
  requireActiveLease,
} from "./attempts.mjs";

export const LAUNCH_SCHEMA = "team-up.launch/v1";
export const LAUNCH_REF_SCHEMA = "team-up.launch-ref/v1";

function resolveCliPath(argv0) {
  if (!argv0) return null;
  let candidate = null;
  if (path.isAbsolute(argv0) && fs.existsSync(argv0)) {
    candidate = argv0;
  } else {
    try {
      const which = execFileSync("which", [argv0], { encoding: "utf8" }).trim();
      candidate = which || null;
    } catch {
      candidate = null;
    }
  }
  if (!candidate) return null;
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function atomicWriteText(filePath, body, mode = 0o444) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o644 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // best-effort immutable
  }
}

function descriptorChecksum(body) {
  return `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
}

/**
 * Persist a complete, rebuildable launch descriptor for successors/resumes.
 */
export function buildLaunchDescriptor({
  cli,
  model,
  effort = null,
  promptPath,
  contextDir,
  project,
  packagePath = null,
  permissions,
  callType,
  broker = null,
  capsuleRoot = null,
  harnessRequirements = {},
  specialistProfile = null,
  limitWindows = [],
  timeoutSeconds = null,
  sandboxRuntimePaths = null,
  specialist = null,
  filesystemMode = null,
  writableProject = false,
}) {
  return {
    schema: LAUNCH_SCHEMA,
    cli,
    model,
    effort,
    prompt_path: promptPath,
    context_dir: contextDir,
    project,
    package_path: packagePath,
    permissions,
    call_type: callType,
    broker,
    capsule_root: capsuleRoot,
    harness_requirements: harnessRequirements,
    specialist_profile: specialistProfile,
    limit_windows: Array.isArray(limitWindows) ? [...limitWindows] : [],
    timeout_seconds: timeoutSeconds,
    sandbox_runtime_paths: sandboxRuntimePaths,
    specialist,
    filesystem_mode: filesystemMode,
    writable_project: Boolean(writableProject),
  };
}

/**
 * Store authoritative descriptor under ~/.team-up/launch-descriptors/<runId>/.
 * STATE.json keeps only a schema-versioned reference + checksum.
 */
export function persistLaunchDescriptor(runId, descriptor, env = process.env) {
  const st = loadState(runId);
  if (!st) throw new Error(`unknown run ${runId}`);
  if (!descriptor || descriptor.schema !== LAUNCH_SCHEMA) {
    throw new Error("invalid launch descriptor");
  }
  const dir = launchDescriptorDir(runId, env);
  const filePath = path.join(dir, "descriptor.json");
  const sumPath = path.join(dir, "descriptor.sha256");
  // Make writable before overwrite (may be 0444 from prior persist).
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o644);
    if (fs.existsSync(sumPath)) fs.chmodSync(sumPath, 0o644);
  } catch {
    // ignore
  }
  const body = `${JSON.stringify(descriptor, null, 2)}\n`;
  const checksum = descriptorChecksum(body);
  atomicWriteText(filePath, body, 0o444);
  atomicWriteText(sumPath, `${checksum}\n`, 0o444);

  st.launch_descriptor = {
    schema: LAUNCH_REF_SCHEMA,
    path: filePath,
    checksum,
    launch_schema: LAUNCH_SCHEMA,
  };
  st.harness_requirements = descriptor.harness_requirements || {};
  st.specialist_profile = descriptor.specialist_profile || st.specialist_profile;
  st.runtime = {
    ...(st.runtime || {}),
    cli: descriptor.cli,
    model: descriptor.model,
    effort: descriptor.effort,
    limit_windows: descriptor.limit_windows || [],
  };
  if (descriptor.specialist) st.specialist = descriptor.specialist;
  saveState(st);
  return descriptor;
}

/**
 * Load + checksum-validate the authoritative descriptor (never from worker STATE).
 */
export function loadAuthoritativeLaunchDescriptor(runId, env = process.env) {
  const dir = launchDescriptorDir(runId, env);
  const filePath = path.join(dir, "descriptor.json");
  const sumPath = path.join(dir, "descriptor.sha256");
  if (!fs.existsSync(filePath)) {
    const err = new Error(`LAUNCH_DESCRIPTOR_MISSING: ${runId}`);
    err.code = "LAUNCH_DESCRIPTOR_MISSING";
    throw err;
  }
  if (!fs.existsSync(sumPath)) {
    const err = new Error(`LAUNCH_DESCRIPTOR_CHECKSUM_MISSING: ${runId}`);
    err.code = "LAUNCH_DESCRIPTOR_CHECKSUM_MISSING";
    throw err;
  }
  let body;
  try {
    body = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    const err = new Error(`LAUNCH_DESCRIPTOR_UNREADABLE: ${runId}: ${e.message}`);
    err.code = "LAUNCH_DESCRIPTOR_UNREADABLE";
    throw err;
  }
  const expected = fs.readFileSync(sumPath, "utf8").trim();
  const actual = descriptorChecksum(body);
  if (actual !== expected) {
    const err = new Error(`LAUNCH_DESCRIPTOR_CHECKSUM_MISMATCH: ${runId}`);
    err.code = "LAUNCH_DESCRIPTOR_CHECKSUM_MISMATCH";
    throw err;
  }
  let descriptor;
  try {
    descriptor = JSON.parse(body);
  } catch {
    const err = new Error(`LAUNCH_DESCRIPTOR_CORRUPT: ${runId}`);
    err.code = "LAUNCH_DESCRIPTOR_CORRUPT";
    throw err;
  }
  if (!descriptor || descriptor.schema !== LAUNCH_SCHEMA) {
    const err = new Error(`LAUNCH_DESCRIPTOR_SCHEMA: ${runId}`);
    err.code = "LAUNCH_DESCRIPTOR_SCHEMA";
    throw err;
  }
  return descriptor;
}

function readPrompt(descriptor) {
  if (descriptor.prompt_path && fs.existsSync(descriptor.prompt_path)) {
    return fs.readFileSync(descriptor.prompt_path, "utf8");
  }
  return `Resume ${descriptor.cli} ${descriptor.model}`;
}

function resolveSandboxProbe(probe) {
  if (process.env.TEAM_UP_SANDBOX_FORCE_NONE === "1") return () => false;
  return probe || systemdAvailable;
}

/**
 * Rebuild the capsule input from the run's audit record so a successor or a
 * resume launches from exactly the capabilities the original run selected.
 */
export function capsuleFromDescriptor(descriptor) {
  const root = descriptor?.capsule_root;
  if (!root) return null;
  const effective = JSON.parse(
    fs.readFileSync(path.join(root, "EFFECTIVE_CAPABILITIES.json"), "utf8")
  );
  return {
    pluginDirs: effective.packages.flatMap((item) =>
      (item.resolved?.plugins ?? []).map((rel) => path.join(root, rel))
    ),
    mcpConfig: buildStrictMcpConfig(effective, root),
    skillDirs: [path.join(root, "context", "skills")],
    frameworkDirs: [path.join(root, "context", "framework")],
    homeDir: path.join(root, "harness", "home"),
    codexHome: path.join(root, "harness", "home"),
    effective,
  };
}

/** Prefix argv with an explicit env assignment without hiding argv[0]. */
export function applyLaunchEnv(argv, env = {}) {
  const pairs = Object.entries(env).filter(([, value]) => value != null);
  if (!pairs.length) return argv;
  return ["/usr/bin/env", ...pairs.map(([key, value]) => `${key}=${value}`), ...argv];
}

/**
 * Rebuild argv with verified harness adapter + sandbox from persisted descriptor.
 * Never uses raw buildCommand alone when broker/harness requirements exist.
 */
export function prepareArgvFromDescriptor(
  descriptor,
  { roster = null, runtimeOverride = null, probe = systemdAvailable, descriptorPath = null } = {}
) {
  const r = roster || requireRoster();
  const cli = runtimeOverride?.cli || descriptor.cli;
  const model = runtimeOverride?.model || descriptor.model;
  const effort = runtimeOverride?.effort ?? descriptor.effort;
  const prompt = readPrompt(descriptor);
  let argv = buildCommand({ roster: r, model, cli, prompt, effort });

  const brokerRequired = Boolean(descriptor.harness_requirements?.command_broker);
  const isolationRequired = Boolean(descriptor.harness_requirements?.context_isolation);
  const broker = descriptor.broker;
  const capsule = capsuleFromDescriptor(descriptor);
  if (isolationRequired && !capsule) {
    const err = new Error(
      "CAPSULE_REQUIRED: harness_requirements.context_isolation set but capsule data missing"
    );
    err.code = "CAPSULE_REQUIRED";
    throw err;
  }
  if (brokerRequired) {
    if (!broker?.policySnapshot || !broker?.policyChecksum) {
      const err = new Error(
        "BROKER_REQUIRED: harness_requirements.command_broker set but broker data missing/invalid"
      );
      err.code = "BROKER_REQUIRED";
      throw err;
    }
  }

  const harnessRunDir =
    broker?.runDir ||
    (descriptor.context_dir ? path.dirname(descriptor.context_dir) : null) ||
    path.dirname(descriptor.prompt_path || ".");

  const brokered = brokerRequired || (broker?.policySnapshot && broker?.policyChecksum);
  let launchEnv = {};
  if (brokered || capsule) {
    if (brokered && (!broker?.policySnapshot || !broker?.policyChecksum)) {
      const err = new Error("BROKER_INVALID: incomplete broker fields");
      err.code = "BROKER_INVALID";
      throw err;
    }
    let prepared;
    try {
      prepared = prepareHarnessLaunch({
        cli,
        argv,
        runDir: harnessRunDir,
        capsule,
        broker: brokered
          ? {
              policySnapshot: broker.policySnapshot,
              policyChecksum: broker.policyChecksum,
              project: broker.project || descriptor.project,
              runDir: broker.runDir || harnessRunDir,
              actionIds: broker.actionIds || descriptor.permissions?.commands || [],
            }
          : null,
        verification:
          brokerRequired || isolationRequired
            ? { status: "verified", cli_version: "launch" }
            : null,
      });
    } catch (e) {
      if (brokerRequired) {
        const err = new Error(
          `BROKER_VERIFY_FAILED: ${e.message || e}`
        );
        err.code = "BROKER_VERIFY_FAILED";
        err.cause = e;
        throw err;
      }
      throw e;
    }
    argv = prepared.argv;
    launchEnv = prepared.env || {};
  }

  const runPath = broker?.runDir || harnessRunDir;
  const cliPath = resolveCliPath(argv[0]);
  const timeoutSec = descriptor.timeout_seconds;
  const readOnlyPaths = [];
  if (cliPath) readOnlyPaths.push(cliPath);
  if (broker?.policySnapshot) readOnlyPaths.push(broker.policySnapshot);
  if (descriptorPath) readOnlyPaths.push(descriptorPath);
  else {
    // Bind the authoritative descriptor directory read-only when known.
    const promptDir = descriptor.prompt_path
      ? path.dirname(path.dirname(descriptor.prompt_path))
      : null;
    // Prefer explicit launch-descriptors path via env TEAM_UP_HOME layout.
  }

  const workerWritable = [
    path.join(runPath, "mailbox"),
    path.join(runPath, "context"),
    path.join(runPath, "attempts"),
    descriptor.context_dir,
  ].filter(Boolean);
  if (fs.existsSync(path.join(runPath, "policy"))) {
    workerWritable.push(path.join(runPath, "policy"));
  }

  const wrapped = wrapWithSandbox({
    command: argv,
    permissions: descriptor.permissions || {},
    cwd: descriptor.context_dir || runPath,
    writablePaths: workerWritable,
    readOnlyPaths,
    callType: descriptor.call_type,
    projectPath:
      descriptor.filesystem_mode === "none" ? null : descriptor.project,
    packagePath: descriptor.package_path,
    runPath,
    cliPath,
    writableProject: descriptor.writable_project === true,
    probe: resolveSandboxProbe(probe),
    timeoutSeconds: timeoutSec,
    sandboxRuntimePaths: descriptor.sandbox_runtime_paths,
    enforcement: "best_effort",
  });

  return {
    // Applied after sandbox wrapping so cliPath resolution still sees the
    // real harness binary as argv[0].
    argv: applyLaunchEnv(wrapped.argv, launchEnv),
    sandbox: wrapped.sandbox,
    enforced: wrapped.enforced === true,
    warning: wrapped.warning ?? null,
    cli,
    model,
    effort,
    dir: descriptor.context_dir || runPath,
  };
}

function defaultStartTmux({ session, dir, argv }) {
  execFileSync("tmux", tmuxArgs({ session, dir, argv }), { stdio: "ignore" });
}

function defaultKillTmux(session) {
  if (!session) return;
  try {
    execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
  } catch {
    // already gone
  }
}

/**
 * Unified production start: prepare harness argv, spawn TMUX, transfer lease.
 * On failure: release lease and roll status back when requested.
 */
export function startFromLaunchDescriptor({
  runId,
  runtimeOverride = null,
  sessionName = null,
  attempt = null,
  now = new Date().toISOString(),
  startTmux = defaultStartTmux,
  killTmux = defaultKillTmux,
  transferOwner = transferLeaseOwner,
  rollbackStatus = "failed",
  probe = systemdAvailable,
  env = process.env,
} = {}) {
  let descriptor = loadAuthoritativeLaunchDescriptor(runId, env);

  if (runtimeOverride) {
    const nextDesc = {
      ...descriptor,
      cli: runtimeOverride.cli || descriptor.cli,
      model: runtimeOverride.model || descriptor.model,
      effort: runtimeOverride.effort ?? descriptor.effort,
    };
    if (Array.isArray(runtimeOverride.limit_windows)) {
      nextDesc.limit_windows = runtimeOverride.limit_windows;
    } else {
      nextDesc.limit_windows = resolveLimitWindowsForCell(runtimeOverride);
    }
    persistLaunchDescriptor(runId, nextDesc, env);
    descriptor = nextDesc;
  }

  const descriptorPath = path.join(launchDescriptorDir(runId, env), "descriptor.json");
  const prepared = prepareArgvFromDescriptor(descriptor, {
    runtimeOverride,
    probe,
    descriptorPath,
  });
  const session =
    sessionName ||
    `team-up-${(descriptor.specialist?.id || "run").replace(/[^a-z0-9]+/gi, "-")}-${Date.now().toString(36)}`;

  const st = loadState(runId);
  let activeAttempt = attempt;
  let createdLease = false;
  if (!activeAttempt) {
    // Initial-start lease ownership: create attempt + acquire reservation.
    activeAttempt = createAttempt({
      runId,
      runtime: {
        cli: prepared.cli,
        model: prepared.model,
        effort: prepared.effort,
        limit_windows: descriptor.limit_windows || [],
      },
      specialist: descriptor.specialist || st?.specialist || null,
      now,
    });
    const lease = acquireAttemptLease({
      runId,
      attemptId: activeAttempt.id,
      expectedPrevious: st?.current_attempt_id ?? null,
      now,
      owner: `starting:pid:${process.pid}`,
      expiresAt: new Date(Date.parse(now) + 120_000).toISOString(),
    });
    if (!lease.ok) {
      const err = new Error(`LEASE_FAILED: ${lease.reason}`);
      err.code = "LEASE_FAILED";
      err.details = lease;
      throw err;
    }
    createdLease = true;
  } else {
    // Controller-supplied lease ownership: must already hold an active lease.
    const active = requireActiveLease({
      runId,
      attemptId: activeAttempt.id,
    });
    if (!active.ok) {
      const err = new Error(`LEASE_REQUIRED: ${active.reason}`);
      err.code = "LEASE_REQUIRED";
      err.details = active;
      throw err;
    }
  }

  try {
    startTmux({
      session,
      dir: prepared.dir,
      argv: prepared.argv,
      runId,
      attempt: activeAttempt,
    });
  } catch (e) {
    if (createdLease || activeAttempt) {
      releaseAttemptLease({
        runId,
        attemptId: activeAttempt.id,
        reason: "start_failed",
        now,
      });
    }
    const live = loadState(runId);
    if (live) {
      live.status = rollbackStatus;
      live.last_start_error = String(e.message || e);
      saveState(live);
      setStatus(runId, rollbackStatus);
    }
    throw e;
  }

  const transferred = transferOwner({
    runId,
    attemptId: activeAttempt.id,
    owner: `tmux:${session}`,
    now,
    clearExpiry: true,
  });
  if (!transferred?.ok) {
    killTmux(session);
    releaseAttemptLease({
      runId,
      attemptId: activeAttempt.id,
      reason: "transfer_failed",
      now,
    });
    const live = loadState(runId);
    if (live) {
      live.status = rollbackStatus;
      live.last_start_error = `LEASE_TRANSFER_FAILED: ${transferred?.reason || "unknown"}`;
      saveState(live);
      setStatus(runId, rollbackStatus);
    }
    const err = new Error(
      `LEASE_TRANSFER_FAILED: ${transferred?.reason || "unknown"}`
    );
    err.code = "LEASE_TRANSFER_FAILED";
    err.details = transferred;
    throw err;
  }

  const live = loadState(runId);
  if (live) {
    live.status = "watching";
    live.worker = {
      ...(live.worker || {}),
      tmux: session,
      cli: prepared.cli,
      model: prepared.model,
      limit_windows: descriptor.limit_windows || [],
    };
    live.runtime = {
      ...(live.runtime || {}),
      cli: prepared.cli,
      model: prepared.model,
      effort: prepared.effort,
      limit_windows: descriptor.limit_windows || [],
    };
    live.current_attempt_id = activeAttempt.id;
    live.sandbox = {
      kind: prepared.sandbox,
      enforced: prepared.enforced,
      warning: prepared.warning,
      enforcement: "best_effort",
    };
    live.last_start_error = null;
    saveState(live);
    setStatus(runId, "watching");
  }

  return {
    runId,
    attempt: activeAttempt,
    session,
    argv: prepared.argv,
    sandbox: prepared.sandbox,
    enforced: prepared.enforced,
  };
}

/**
 * Start a successor using the same descriptor with a new runtime cell.
 */
export function startSuccessorFromDescriptor({
  runId,
  cell,
  attempt,
  now = new Date().toISOString(),
  startTmux = defaultStartTmux,
  killTmux = defaultKillTmux,
  transferOwner = transferLeaseOwner,
  probe = systemdAvailable,
  env = process.env,
}) {
  const roster = requireRoster();
  const limit_windows = resolveLimitWindowsForCell(cell, roster);
  const session = `team-up-handoff-${runId.slice(0, 8)}-${Date.now().toString(36)}`;
  return startFromLaunchDescriptor({
    runId,
    runtimeOverride: { ...cell, limit_windows },
    sessionName: session,
    attempt,
    now,
    startTmux,
    killTmux,
    transferOwner,
    probe,
    env,
    rollbackStatus: "handing_off",
  });
}

export function resolveLimitWindowsForCell(cell, roster = null) {
  const r = roster || requireRoster();
  const model = r?.models?.[cell?.model];
  if (Array.isArray(cell?.limit_windows) && cell.limit_windows.length) {
    return cell.limit_windows;
  }
  if (Array.isArray(model?.limit_windows)) return model.limit_windows;
  return [];
}

export function loadUsageDoc() {
  return loadJson(usagePath()) || { windows: {} };
}
