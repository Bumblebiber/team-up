import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadState, saveState, runDir, setStatus } from "../runs/runs.mjs";
import { buildCommand, tmuxArgs } from "../roster/command.mjs";
import { requireRoster, loadJson, usagePath } from "../roster/config.mjs";
import { prepareHarnessLaunch } from "../harness/registry.mjs";
import { wrapWithSandbox, systemdAvailable } from "../sandbox/systemd.mjs";
import {
  acquireAttemptLease,
  releaseAttemptLease,
  transferLeaseOwner,
  createAttempt,
} from "./attempts.mjs";

export const LAUNCH_SCHEMA = "team-up.launch/v1";

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
    specialist_profile: specialistProfile,
    limit_windows: Array.isArray(limitWindows) ? [...limitWindows] : [],
    timeout_seconds: timeoutSeconds,
    sandbox_runtime_paths: sandboxRuntimePaths,
    specialist,
    filesystem_mode: filesystemMode,
    writable_project: Boolean(writableProject),
  };
}

export function persistLaunchDescriptor(runId, descriptor) {
  const st = loadState(runId);
  if (!st) throw new Error(`unknown run ${runId}`);
  if (!descriptor || descriptor.schema !== LAUNCH_SCHEMA) {
    throw new Error("invalid launch descriptor");
  }
  st.launch_descriptor = descriptor;
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

function readPrompt(descriptor) {
  if (descriptor.prompt_path && fs.existsSync(descriptor.prompt_path)) {
    return fs.readFileSync(descriptor.prompt_path, "utf8");
  }
  return `Resume ${descriptor.cli} ${descriptor.model}`;
}

/**
 * Rebuild argv with verified harness adapter + sandbox from persisted descriptor.
 * Never uses raw buildCommand alone when broker/harness requirements exist.
 */
function resolveSandboxProbe(probe) {
  if (process.env.TEAM_UP_SANDBOX_FORCE_NONE === "1") return () => false;
  return probe || systemdAvailable;
}

export function prepareArgvFromDescriptor(descriptor, { roster = null, runtimeOverride = null, probe = systemdAvailable } = {}) {
  const r = roster || requireRoster();
  const cli = runtimeOverride?.cli || descriptor.cli;
  const model = runtimeOverride?.model || descriptor.model;
  const effort = runtimeOverride?.effort ?? descriptor.effort;
  const prompt = readPrompt(descriptor);
  let argv = buildCommand({ roster: r, model, cli, prompt, effort });

  const broker = descriptor.broker;
  const harnessRunDir =
    broker?.runDir ||
    (descriptor.context_dir ? path.dirname(descriptor.context_dir) : null) ||
    path.dirname(descriptor.prompt_path || ".");
  if (broker?.policySnapshot && broker?.policyChecksum) {
    const prepared = prepareHarnessLaunch({
      cli,
      argv,
      runDir: harnessRunDir,
      broker: {
        policySnapshot: broker.policySnapshot,
        policyChecksum: broker.policyChecksum,
        project: broker.project || descriptor.project,
        runDir: broker.runDir || harnessRunDir,
        actionIds: broker.actionIds || descriptor.permissions?.commands || [],
      },
      verification: descriptor.harness_requirements?.command_broker
        ? { status: "verified", cli_version: "launch" }
        : null,
    });
    argv = prepared.argv;
  }

  const runPath = broker?.runDir || harnessRunDir;
  const cliPath = resolveCliPath(argv[0]);
  const timeoutSec = descriptor.timeout_seconds;
  const readOnlyPaths = [];
  if (cliPath) readOnlyPaths.push(cliPath);
  if (broker?.policySnapshot) readOnlyPaths.push(broker.policySnapshot);

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
  rollbackStatus = "failed",
  probe = systemdAvailable,
} = {}) {
  const st = loadState(runId);
  if (!st?.launch_descriptor) {
    throw new Error(`LAUNCH_DESCRIPTOR_MISSING: ${runId}`);
  }
  const descriptor = st.launch_descriptor;
  const prepared = prepareArgvFromDescriptor(descriptor, { runtimeOverride, probe });
  const session =
    sessionName ||
    `team-up-${(descriptor.specialist?.id || "run").replace(/[^a-z0-9]+/gi, "-")}-${Date.now().toString(36)}`;

  let activeAttempt = attempt;
  let createdLease = false;
  if (!activeAttempt) {
    activeAttempt = createAttempt({
      runId,
      runtime: {
        cli: prepared.cli,
        model: prepared.model,
        effort: prepared.effort,
        limit_windows: descriptor.limit_windows || [],
      },
      specialist: descriptor.specialist || st.specialist || null,
      now,
    });
    const lease = acquireAttemptLease({
      runId,
      attemptId: activeAttempt.id,
      expectedPrevious: st.current_attempt_id ?? null,
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

  transferLeaseOwner({
    runId,
    attemptId: activeAttempt.id,
    owner: `tmux:${session}`,
    now,
    clearExpiry: true,
  });

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
  probe = systemdAvailable,
}) {
  const st = loadState(runId);
  if (!st?.launch_descriptor) {
    throw new Error(`LAUNCH_DESCRIPTOR_MISSING: ${runId}`);
  }
  // Update descriptor model/cli for the new attempt while keeping harness bits.
  const nextDesc = {
    ...st.launch_descriptor,
    cli: cell.cli,
    model: cell.model,
    effort: cell.effort ?? st.launch_descriptor.effort,
  };
  if (Array.isArray(cell.limit_windows)) {
    nextDesc.limit_windows = cell.limit_windows;
  } else {
    const roster = requireRoster();
    const model = roster?.models?.[cell.model];
    if (Array.isArray(model?.limit_windows)) {
      nextDesc.limit_windows = model.limit_windows;
    }
  }
  persistLaunchDescriptor(runId, nextDesc);

  const session = `team-up-handoff-${runId.slice(0, 8)}-${Date.now().toString(36)}`;
  return startFromLaunchDescriptor({
    runId,
    runtimeOverride: cell,
    sessionName: session,
    attempt,
    now,
    startTmux,
    probe,
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
