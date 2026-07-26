import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadState, saveState, setStatus } from "../runs/runs.mjs";
import { buildCommand, tmuxArgs } from "../roster/command.mjs";
import { requireRoster, loadJson, usagePath } from "../roster/config.mjs";
import { prepareHarnessLaunch } from "../harness/registry.mjs";
import { wrapWithSandbox, systemdAvailable } from "../sandbox/systemd.mjs";
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
export const CAPSULE_LAUNCH_SCHEMA = "team-up.capsule-launch/v1";

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
 * Schema-versioned capsule launch record for successor/resume reconstruction.
 * Stored inside the checksum-bound launch descriptor (outside worker-writable paths).
 */
export function buildCapsuleLaunchRecord({ runRoot, capsule, env = process.env }) {
  if (!capsule || !runRoot) {
    const err = new Error("CAPSULE_LAUNCH_REQUIRED: capsule and runRoot required");
    err.code = "CAPSULE_LAUNCH_REQUIRED";
    throw err;
  }
  const effectivePath =
    capsule.effectivePath || path.join(runRoot, "EFFECTIVE_CAPABILITIES.json");
  if (!fs.existsSync(effectivePath)) {
    const err = new Error(`CAPSULE_LAUNCH_EFFECTIVE_MISSING: ${effectivePath}`);
    err.code = "CAPSULE_LAUNCH_EFFECTIVE_MISSING";
    throw err;
  }
  const effectiveBody = fs.readFileSync(effectivePath);
  const effectiveChecksum = descriptorChecksum(effectiveBody);
  const authDir = launchDescriptorDir(
    path.basename(path.resolve(runRoot)),
    env
  );
  // Authoritative copy lives beside descriptor.json when runId is known later;
  // checksum binds content regardless of worker-writable path mutations.
  return {
    schema: CAPSULE_LAUNCH_SCHEMA,
    run_root: path.resolve(runRoot),
    plugin_dirs: [...(capsule.pluginDirs ?? [])].map((p) => path.resolve(p)),
    skill_dirs: [...(capsule.skillDirs ?? [])].map((p) => path.resolve(p)),
    framework_dirs: [...(capsule.frameworkDirs ?? [])].map((p) => path.resolve(p)),
    codex_home: capsule.codexHome ? path.resolve(capsule.codexHome) : null,
    mcp_config: capsule.mcpConfig ?? { mcpServers: {} },
    mcp_tool_names: [...(capsule.mcpToolNames ?? [])],
    mcp_tools_by_server: { ...(capsule.mcpToolsByServer ?? {}) },
    effective_path: path.resolve(effectivePath),
    effective_checksum: effectiveChecksum,
    // Placeholder filled by persistLaunchDescriptor once runId is known.
    authoritative_effective_path: null,
  };
}

/**
 * Fail-closed reconstruction of the runtime capsule object from a launch record.
 */
export function reconstructCapsuleFromLaunchRecord(record) {
  if (!record || record.schema !== CAPSULE_LAUNCH_SCHEMA) {
    const err = new Error("CAPSULE_LAUNCH_SCHEMA: invalid capsule launch record");
    err.code = "CAPSULE_LAUNCH_SCHEMA";
    throw err;
  }
  const effectivePath =
    (record.authoritative_effective_path &&
      fs.existsSync(record.authoritative_effective_path) &&
      record.authoritative_effective_path) ||
    record.effective_path;
  if (!effectivePath || !fs.existsSync(effectivePath)) {
    const err = new Error("CAPSULE_LAUNCH_EFFECTIVE_MISSING: effective capabilities absent");
    err.code = "CAPSULE_LAUNCH_EFFECTIVE_MISSING";
    throw err;
  }
  const body = fs.readFileSync(effectivePath);
  const actual = descriptorChecksum(body);
  if (actual !== record.effective_checksum) {
    const err = new Error("CAPSULE_LAUNCH_CHECKSUM: effective capabilities checksum mismatch");
    err.code = "CAPSULE_LAUNCH_CHECKSUM";
    throw err;
  }
  let effective;
  try {
    effective = JSON.parse(body.toString("utf8"));
  } catch {
    const err = new Error("CAPSULE_LAUNCH_CORRUPT: effective capabilities unreadable");
    err.code = "CAPSULE_LAUNCH_CORRUPT";
    throw err;
  }
  for (const dir of [...(record.plugin_dirs ?? [])]) {
    if (!fs.existsSync(dir)) {
      const err = new Error(`CAPSULE_LAUNCH_PATH_MISSING: ${dir}`);
      err.code = "CAPSULE_LAUNCH_PATH_MISSING";
      throw err;
    }
  }
  // Skill/framework roots may be empty but must exist for --add-dir.
  for (const dir of [
    ...(record.skill_dirs ?? []),
    ...(record.framework_dirs ?? []),
  ]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  if (record.codex_home) {
    fs.mkdirSync(record.codex_home, { recursive: true });
  }
  return {
    pluginDirs: [...(record.plugin_dirs ?? [])],
    skillDirs: [...(record.skill_dirs ?? [])],
    frameworkDirs: [...(record.framework_dirs ?? [])],
    codexHome: record.codex_home,
    mcpConfig: record.mcp_config ?? { mcpServers: {} },
    mcpToolNames: [...(record.mcp_tool_names ?? [])],
    mcpToolsByServer: { ...(record.mcp_tools_by_server ?? {}) },
    effective,
    effectivePath,
  };
}

function injectAdapterEnv(argv, envMap) {
  const entries = Object.entries(envMap || {}).filter(
    ([, v]) => v != null && v !== ""
  );
  if (!entries.length) return argv;
  return ["env", ...entries.map(([k, v]) => `${k}=${v}`), ...argv];
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
  harnessRequirements = {},
  harnessVerification = null,
  capsuleLaunch = null,
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
    harness_requirements: harnessRequirements,
    harness_verification: harnessVerification,
    capsule_launch: capsuleLaunch,
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

  const next = { ...descriptor };
  if (next.capsule_launch) {
    if (next.capsule_launch.schema !== CAPSULE_LAUNCH_SCHEMA) {
      const err = new Error("CAPSULE_LAUNCH_SCHEMA: invalid capsule_launch on persist");
      err.code = "CAPSULE_LAUNCH_SCHEMA";
      throw err;
    }
    const authEffective = path.join(dir, "EFFECTIVE_CAPABILITIES.json");
    const sourcePath = next.capsule_launch.effective_path;
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      const err = new Error("CAPSULE_LAUNCH_EFFECTIVE_MISSING: cannot persist capsule");
      err.code = "CAPSULE_LAUNCH_EFFECTIVE_MISSING";
      throw err;
    }
    const body = fs.readFileSync(sourcePath);
    const checksum = descriptorChecksum(body);
    if (checksum !== next.capsule_launch.effective_checksum) {
      const err = new Error("CAPSULE_LAUNCH_CHECKSUM: effective changed before persist");
      err.code = "CAPSULE_LAUNCH_CHECKSUM";
      throw err;
    }
    atomicWriteText(authEffective, body.toString("utf8"), 0o444);
    next.capsule_launch = {
      ...next.capsule_launch,
      authoritative_effective_path: authEffective,
    };
  }

  const body = `${JSON.stringify(next, null, 2)}\n`;
  const checksum = descriptorChecksum(body);
  atomicWriteText(filePath, body, 0o444);
  atomicWriteText(sumPath, `${checksum}\n`, 0o444);

  st.launch_descriptor = {
    schema: LAUNCH_REF_SCHEMA,
    path: filePath,
    checksum,
    launch_schema: LAUNCH_SCHEMA,
  };
  st.harness_requirements = next.harness_requirements || {};
  st.specialist_profile = next.specialist_profile || st.specialist_profile;
  st.runtime = {
    ...(st.runtime || {}),
    cli: next.cli,
    model: next.model,
    effort: next.effort,
    limit_windows: next.limit_windows || [],
  };
  if (next.specialist) st.specialist = next.specialist;
  saveState(st);
  return next;
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
  const isolationRequired = Boolean(
    descriptor.harness_requirements?.context_isolation
  );
  const broker = descriptor.broker;
  if (brokerRequired) {
    if (!broker?.policySnapshot || !broker?.policyChecksum) {
      const err = new Error(
        "BROKER_REQUIRED: harness_requirements.command_broker set but broker data missing/invalid"
      );
      err.code = "BROKER_REQUIRED";
      throw err;
    }
  }

  let capsule = null;
  if (isolationRequired) {
    if (!descriptor.capsule_launch) {
      const err = new Error(
        "CAPSULE_LAUNCH_MISSING: context isolation required but capsule_launch absent"
      );
      err.code = "CAPSULE_LAUNCH_MISSING";
      throw err;
    }
    capsule = reconstructCapsuleFromLaunchRecord(descriptor.capsule_launch);
  } else if (descriptor.capsule_launch) {
    capsule = reconstructCapsuleFromLaunchRecord(descriptor.capsule_launch);
  }

  const harnessRunDir =
    broker?.runDir ||
    descriptor.capsule_launch?.run_root ||
    (descriptor.context_dir ? path.dirname(descriptor.context_dir) : null) ||
    path.dirname(descriptor.prompt_path || ".");

  const needsHarnessPrepare =
    Boolean(capsule) ||
    brokerRequired ||
    Boolean(broker?.policySnapshot && broker?.policyChecksum);

  let adapterEnv = {};
  if (needsHarnessPrepare) {
    if (broker && (!broker.policySnapshot || !broker.policyChecksum)) {
      const err = new Error("BROKER_INVALID: incomplete broker fields");
      err.code = "BROKER_INVALID";
      throw err;
    }
    const verification =
      descriptor.harness_verification ||
      (brokerRequired || isolationRequired
        ? {
            status: "verified",
            ...(brokerRequired
              ? { command_broker: descriptor.harness_requirements.command_broker }
              : {}),
            ...(isolationRequired
              ? {
                  context_isolation:
                    descriptor.harness_requirements.context_isolation,
                }
              : {}),
            cli_version: "launch",
          }
        : null);
    let prepared;
    try {
      prepared = prepareHarnessLaunch({
        cli,
        argv,
        runDir: harnessRunDir,
        broker: broker
          ? {
              policySnapshot: broker.policySnapshot,
              policyChecksum: broker.policyChecksum,
              project: broker.project || descriptor.project,
              runDir: broker.runDir || harnessRunDir,
              actionIds: broker.actionIds || descriptor.permissions?.commands || [],
            }
          : null,
        capsule,
        verification,
      });
    } catch (e) {
      if (brokerRequired || isolationRequired) {
        const err = new Error(
          `BROKER_VERIFY_FAILED: ${e.message || e}`
        );
        err.code = e.code || "BROKER_VERIFY_FAILED";
        err.cause = e;
        throw err;
      }
      throw e;
    }
    argv = prepared.argv;
    adapterEnv = { ...(prepared.env || {}) };
    argv = injectAdapterEnv(argv, adapterEnv);
  }

  const runPath = broker?.runDir || harnessRunDir;
  const cliPath = resolveCliPath(argv.find((a) => !String(a).includes("=") && a !== "env") || argv[0]);
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
    void promptDir;
  }
  if (descriptor.capsule_launch?.authoritative_effective_path) {
    readOnlyPaths.push(descriptor.capsule_launch.authoritative_effective_path);
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
    argv: wrapped.argv,
    env: adapterEnv,
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
