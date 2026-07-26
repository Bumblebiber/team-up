import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadInstalledManifest, verifyInstalledIntegrity } from "./store.mjs";
import { isApproved } from "./approvals.mjs";
import { normalizeRequest } from "./request.mjs";
import { intersectPermissions, assertCallTypeAllowed } from "./permissions.mjs";
import { resolveProfile } from "../roster/profile.mjs";
import { requireRoster, loadJson, usagePath } from "../roster/config.mjs";
import { buildCommand, tmuxArgs } from "../roster/command.mjs";
import {
  createRun,
  runDir,
  wrapPromptWithMailboxProtocol,
  atomicWriteText,
  linkDispatchToRun,
  saveState,
  loadState,
  setStatus,
} from "../runs/runs.mjs";
import { materialize } from "../sandbox/materialize.mjs";
import { wrapWithSandbox, systemdAvailable } from "../sandbox/systemd.mjs";
import { resolveCommandMediation } from "./adapters.mjs";
import { normalizeBudget } from "./budget.mjs";
import {
  resolveCommandPolicyForApproval,
  snapshotCommandPolicy,
} from "../commands/policy.mjs";
import {
  defaultHarnessCapabilities,
  prepareHarnessLaunch,
  getAdapter,
} from "../harness/registry.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../harness/capabilities.mjs";
import { loadAssignments } from "../capabilities/assignments.mjs";
import { listInstalledCapabilities } from "../capabilities/store.mjs";
import { resolveCapabilities } from "../capabilities/resolve.mjs";
import {
  materializeCapabilityCapsule,
  buildStrictMcpConfig,
} from "../capabilities/capsule.mjs";
import { atomicWriteJson } from "../json-store.mjs";
import {
  buildLaunchDescriptor,
  buildCapsuleLaunchRecord,
  persistLaunchDescriptor,
  startFromLaunchDescriptor,
  prepareArgvFromDescriptor,
  resolveLimitWindowsForCell,
  loadAuthoritativeLaunchDescriptor,
} from "../supervisor/start.mjs";

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/** Resolve argv0 to a realpath (follow symlink wrappers). */
export function resolveCliPath(argv0) {
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
 * CLI sandbox config. Legacy mediated_commands boolean never enables
 * enforcement — verified harness command_broker capability does.
 * Token targets are always advisory; no token_budget_adapter gate.
 */
export function cliSandboxConfig(roster, cli, { harnessCapabilities: caps } = {}) {
  const entry = roster?.clis?.[cli] || {};
  const sandbox = entry.sandbox && typeof entry.sandbox === "object" ? entry.sandbox : {};
  const resolvedCaps = caps ?? defaultHarnessCapabilities(cli);
  const cmd = resolveCommandMediation(sandbox, entry, { harnessCapabilities: resolvedCaps });
  return {
    mediated_commands: cmd.enabled,
    command_adapter: cmd.adapter,
    harness_capabilities: resolvedCaps,
    sandbox_runtime_paths:
      sandbox.runtime_paths ??
      entry.sandbox_runtime_paths ??
      null,
  };
}

function needsCommandMediation(effectivePerms, manifest) {
  if ((effectivePerms.commands || []).length > 0) return true;
  const tools = effectivePerms.tools ?? manifest?.capabilities?.tools ?? [];
  return tools.some((t) => /^(command|shell|exec)([.]|$)/i.test(String(t)));
}

function collectCapsuleMcpTools(effective, runRoot) {
  const mcpToolsByServer = {};
  const mcpToolNames = [];
  for (const item of effective.packages ?? []) {
    for (const rel of item.resolved?.mcps ?? []) {
      const document = JSON.parse(fs.readFileSync(path.join(runRoot, rel), "utf8"));
      const sharedTools = Array.isArray(document.tools) ? document.tools : [];
      for (const [name, server] of Object.entries(document.mcpServers ?? {})) {
        const tools = Array.isArray(server?.tools) ? server.tools : sharedTools;
        mcpToolsByServer[name] = tools;
        for (const tool of tools) {
          mcpToolNames.push(
            `mcp__${name}__${String(tool).replace(/-/g, "_")}`
          );
        }
      }
    }
  }
  return { mcpToolNames, mcpToolsByServer };
}

/**
 * Launch API used by tests and CLI.
 */
export async function launch({
  specialistId,
  callType,
  objective,
  project,
  inputs = [],
  sandbox = {},
  permissions,
  env = process.env,
  dryRun = false,
  dependencyOverrides = {},
}) {
  const resolveEffectiveCapabilities =
    dependencyOverrides.resolveEffectiveCapabilities ??
    (() => resolveCapabilities({
      specialistId,
      assignments: loadAssignments({ env }).assignments,
      installed: listInstalledCapabilities({ env }),
    }));
  const materializeCapabilityCapsuleFn =
    dependencyOverrides.materializeCapabilityCapsule ?? materializeCapabilityCapsule;
  const createRunFn = dependencyOverrides.createRun ?? createRun;
  const startFromLaunchDescriptorFn =
    dependencyOverrides.startFromLaunchDescriptor ?? startFromLaunchDescriptor;
  const harnessCapabilitiesFn =
    dependencyOverrides.harnessCapabilities ?? defaultHarnessCapabilities;
  const prepareHarnessLaunchFn =
    dependencyOverrides.prepareHarnessLaunch ?? prepareHarnessLaunch;
  const installed = loadInstalledManifest(specialistId, { project, env });
  if (!installed) {
    const err = new Error(`specialist not installed: ${specialistId}`);
    err.code = "NOT_INSTALLED";
    throw err;
  }
  const manifest = installed.manifest;

  try {
    verifyInstalledIntegrity(installed, manifest);
  } catch (e) {
    e.code = e.code || "PACKAGE_INTEGRITY_FAILED";
    throw e;
  }

  try {
    assertCallTypeAllowed(callType, manifest);
  } catch (e) {
    e.code = "CALL_TYPE_DENIED";
    throw e;
  }

  let commandPolicyChecksum = null;
  let projectPolicy = null;
  try {
    ({ checksum: commandPolicyChecksum, policy: projectPolicy } = resolveCommandPolicyForApproval({
      project,
      permissions: manifest.permissions,
      env,
    }));
  } catch (e) {
    e.code = e.code || "COMMAND_POLICY_INVALID";
    throw e;
  }

  if (!isApproved({
    project,
    id: specialistId,
    version: installed.version,
    checksum: installed.checksum,
    permissions: manifest.permissions,
    command_policy_checksum: commandPolicyChecksum,
    env,
  })) {
    const err = new Error(`specialist not approved for project (checksum/permissions binding)`);
    err.code = "NOT_APPROVED";
    throw err;
  }

  let effectivePerms;
  try {
    effectivePerms = intersectPermissions(
      manifest.permissions,
      permissions ?? null,
      { capabilities: manifest.capabilities }
    );
  } catch (e) {
    e.code = "PERMISSION_ESCALATION";
    throw e;
  }

  const allowedCommands = new Set(manifest.permissions?.commands || []);
  for (const c of effectivePerms.commands || []) {
    if (!allowedCommands.has(c)) {
      const err = new Error(`undeclared command in launch allowlist: ${c}`);
      err.code = "ALLOWLIST_VIOLATION";
      throw err;
    }
  }

  const roster = requireRoster();
  const usage = loadJson(usagePath());
  const capabilityResolution = resolveEffectiveCapabilities();
  const requirements = {
    context_isolation: CONTEXT_ISOLATION_CAPABILITY,
    ...((manifest.permissions?.commands || []).length > 0
      ? { command_broker: "team-up.command-broker/v1" } : {}),
  };
  const profileResult = resolveProfile({
    roster,
    usage,
    profile: manifest.model_profile,
    specialistId,
    callType,
    requirements,
    harnessCapabilities: harnessCapabilitiesFn,
  });
  if (profileResult.code !== "OK") {
    const err = new Error(`PROFILE_UNAVAILABLE: ${JSON.stringify(profileResult.skipped.slice(0, 5))}`);
    err.code = "PROFILE_UNAVAILABLE";
    err.details = profileResult;
    throw err;
  }
  const cell = profileResult.chain[0];
  const harnessCaps = harnessCapabilitiesFn(cell.cli);
  const cliCfg = cliSandboxConfig(roster, cell.cli, { harnessCapabilities: harnessCaps });

  const budgetNorm = normalizeBudget(manifest.budget ?? {});

  const fsMode = effectivePerms.filesystem;
  const runCwd = fsMode === "none" ? null : project;

  const barePrompt = [
    `# Specialist ${manifest.display_name} (${callType})`,
    "",
    `Objective: ${objective}`,
    "",
    "Read context/specialist and selected skill/framework directories under context/.",
    "Read REQUEST.json and instructions.md in the context directory. Follow remit/anti-remit.",
    "Write mailbox/RESULT.json conforming to schema team-up.result/v1 when done.",
    "RESULT.md is optional human-readable detail and does not count as success by itself.",
    budgetNorm.tokens
      ? `Advisory token target: ${budgetNorm.tokens.target} (not hard-enforced).`
      : null,
    budgetNorm.timeout_seconds
      ? `Timeout budget: ${budgetNorm.timeout_seconds}s (enforced by sandbox runtime or timeout(1) fallback).`
      : null,
  ].filter(Boolean).join("\n");

  const state = createRunFn({
    cwd: runCwd || undefined,
    project: fsMode === "none" ? null : project,
    role: `specialist:${specialistId}`,
    parent: { cli: "team-up", attach: "manual" },
    worker: { cli: cell.cli, model: cell.model },
    prompt: barePrompt,
    result_protocol: "RESULT.json",
  });

  let policySnapshot = null;
  if (projectPolicy) {
    policySnapshot = snapshotCommandPolicy({
      policy: projectPolicy,
      runId: state.runId,
      workerVisibleDir: path.join(runDir(state.runId), "policy"),
    });
  }

  const request = normalizeRequest({
    specialist_id: specialistId,
    specialist_version: installed.version,
    call_type: callType,
    objective,
    inputs,
    permissions: effectivePerms,
    budget: {
      timeout_seconds: budgetNorm.timeout_seconds,
      tokens: budgetNorm.tokens,
    },
  });
  request.run_id = state.runId;

  const st = loadState(state.runId);
  st.budget = {
    timeout_seconds: budgetNorm.timeout_seconds,
    tokens: budgetNorm.tokens,
    warnings: budgetNorm.warnings,
  };
  st.command_policy = policySnapshot
    ? { checksum: policySnapshot.checksum, snapshot: policySnapshot.path }
    : { checksum: null, snapshot: null };
  st.output_contract = "team-up.result/v1";
  st.result_protocol = "RESULT.json";
  saveState(st);

  const dest = path.join(runDir(state.runId), "context");
  await materialize({
    packageDir: installed.path,
    request,
    destination: dest,
    manifest,
    projectRoot: fsMode === "none" ? null : project,
    inputs,
    filesystem: fsMode,
  });

  let effective;
  let capsule;
  try {
    effective = materializeCapabilityCapsuleFn({
      runRoot: runDir(state.runId),
      specialistId,
      packages: capabilityResolution.packages,
      exclusions: capabilityResolution.exclusions,
    });
    capsule = {
      pluginDirs: effective.packages.flatMap((item) =>
        item.resolved.plugins.map((rel) => path.join(runDir(state.runId), rel))),
      mcpConfig: buildStrictMcpConfig(effective, runDir(state.runId)),
      skillDirs: [path.join(runDir(state.runId), "context", "skills")],
      frameworkDirs: [path.join(runDir(state.runId), "context", "framework")],
      codexHome: path.join(runDir(state.runId), "harness", "home"),
      effective,
      ...collectCapsuleMcpTools(effective, runDir(state.runId)),
    };
    for (const dir of [
      ...capsule.skillDirs,
      ...capsule.frameworkDirs,
      capsule.codexHome,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (e) {
    setStatus(state.runId, "failed");
    throw e;
  }

  atomicWriteJson(path.join(runDir(state.runId), "mailbox", "REQUEST.json"), request);

  const workerPrompt = wrapPromptWithMailboxProtocol(barePrompt, {
    runId: state.runId,
    runDirectory: runDir(state.runId),
    resultProtocol: "RESULT.json",
  });
  atomicWriteText(path.join(runDir(state.runId), "mailbox", "PROMPT.md"), workerPrompt);

  const cliArgvRaw = buildCommand({
    roster,
    model: cell.model,
    cli: cell.cli,
    prompt: workerPrompt,
    effort: cell.effort,
  });

  const runPath = runDir(state.runId);
  const broker = policySnapshot
    ? {
        policySnapshot: policySnapshot.path,
        policyChecksum: policySnapshot.checksum,
        project: path.resolve(project),
        runDir: runPath,
        actionIds: effectivePerms.commands || [],
      }
    : null;
  const prepared = prepareHarnessLaunchFn({
    cli: cell.cli,
    argv: cliArgvRaw,
    runDir: runPath,
    broker,
    capsule,
    env,
    verification: {
      status: "verified",
      adapter: cell.cli,
      cli_version: (() => {
        try {
          return getAdapter(cell.cli).version({ execFileSync });
        } catch {
          return null;
        }
      })(),
      command_broker: harnessCaps.command_broker,
      context_isolation: harnessCaps.context_isolation,
    },
  });
  let cliArgv = prepared.argv;

  const cliPath = resolveCliPath(cliArgv[0]);
  const timeoutSec = budgetNorm.timeout_seconds;
  const limitWindows = resolveLimitWindowsForCell(cell, roster);

  const probe = sandbox?.probe
    ? sandbox.probe
    : systemdAvailable;

  const workerWritable = [
    path.join(runPath, "mailbox"),
    path.join(runPath, "context"),
    path.join(runPath, "attempts"),
    dest,
  ];
  if (fs.existsSync(path.join(runPath, "policy"))) {
    workerWritable.push(path.join(runPath, "policy"));
  }

  const readOnlyPaths = [];
  if (cliPath) readOnlyPaths.push(cliPath);
  // Authoritative policy snapshot must remain readable under ProtectHome.
  if (policySnapshot?.path) readOnlyPaths.push(policySnapshot.path);

  const wrapped = wrapWithSandbox({
    command: cliArgv,
    permissions: effectivePerms,
    cwd: dest,
    writablePaths: workerWritable,
    readOnlyPaths,
    callType,
    projectPath: fsMode === "none" ? null : project,
    packagePath: installed.path,
    runPath,
    cliPath,
    writableProject:
      fsMode !== "none" &&
      callType === "delegate" &&
      (effectivePerms.writes === "delegated_only" || effectivePerms.writes === true) &&
      effectivePerms.filesystem === "project",
    probe,
    timeoutSeconds: timeoutSec,
    sandboxRuntimePaths: cliCfg.sandbox_runtime_paths,
    enforcement: "best_effort",
  });

  const capsuleLaunch = buildCapsuleLaunchRecord({
    runRoot: runPath,
    capsule: {
      ...capsule,
      effectivePath: path.join(runPath, "EFFECTIVE_CAPABILITIES.json"),
    },
    env,
  });
  const descriptor = buildLaunchDescriptor({
    cli: cell.cli,
    model: cell.model,
    effort: cell.effort,
    promptPath: path.join(runPath, "mailbox", "PROMPT.md"),
    contextDir: dest,
    project: fsMode === "none" ? null : path.resolve(project),
    packagePath: installed.path,
    permissions: effectivePerms,
    callType,
    broker: policySnapshot
      ? {
          policySnapshot: policySnapshot.path,
          policyChecksum: policySnapshot.checksum,
          project: path.resolve(project),
          runDir: runPath,
          actionIds: effectivePerms.commands || [],
        }
      : null,
    harnessRequirements: requirements,
    harnessVerification: {
      status: "verified",
      adapter: cell.cli,
      cli_version: (() => {
        try {
          return getAdapter(cell.cli).version({ execFileSync });
        } catch {
          return null;
        }
      })(),
      command_broker: harnessCaps.command_broker,
      context_isolation: harnessCaps.context_isolation,
    },
    capsuleLaunch,
    specialistProfile: profileResult.profile,
    limitWindows,
    timeoutSeconds: timeoutSec,
    sandboxRuntimePaths: cliCfg.sandbox_runtime_paths,
    specialist: {
      id: specialistId,
      version: installed.version,
      checksum: installed.checksum,
    },
    filesystemMode: fsMode,
    writableProject:
      fsMode !== "none" &&
      callType === "delegate" &&
      (effectivePerms.writes === "delegated_only" || effectivePerms.writes === true) &&
      effectivePerms.filesystem === "project",
  });
  persistLaunchDescriptor(state.runId, descriptor);

  const stAfter = loadState(state.runId);
  stAfter.sandbox = {
    kind: wrapped.sandbox,
    enforced: wrapped.enforced === true,
    warning: wrapped.warning ?? null,
    enforcement: "best_effort",
  };
  stAfter.harness_requirements = requirements;
  stAfter.specialist_profile = profileResult.profile;
  stAfter.runtime = {
    cli: cell.cli,
    model: cell.model,
    effort: cell.effort,
    limit_windows: limitWindows,
  };
  stAfter.budget = st.budget;
  stAfter.command_policy = st.command_policy;
  stAfter.output_contract = st.output_contract;
  stAfter.result_protocol = st.result_protocol;
  saveState(stAfter);

  if (!dryRun) {
    const session = `team-up-${specialistId.replace(/[^a-z0-9]+/gi, "-")}-${Date.now().toString(36)}`;
    const startTmux =
      sandbox?.startWorker ||
      (({ argv, dir, sessionName }) => {
        execFileSync("tmux", tmuxArgs({ session: sessionName, dir, argv }), {
          stdio: "inherit",
        });
      });
    try {
      startFromLaunchDescriptorFn({
        runId: state.runId,
        sessionName: session,
        probe,
        startTmux: ({ session: sess, dir, argv }) => {
          startTmux({
            argv,
            dir,
            sessionName: sess,
            runId: state.runId,
          });
        },
        rollbackStatus: "failed",
      });
    } catch (e) {
      throw e;
    }
    linkDispatchToRun(state.runId, session);
  } else {
    const dryState = loadState(state.runId);
    dryState.dry_run = true;
    saveState(dryState);
    setStatus(state.runId, "cancelled");
  }

  const live = loadState(state.runId);
  return {
    runId: state.runId,
    runtime: {
      cli: cell.cli,
      model: cell.model,
      effort: cell.effort,
      limit_windows: limitWindows,
    },
    sandbox: live?.sandbox?.kind || wrapped.sandbox,
    enforced: live?.sandbox?.enforced === true || wrapped.enforced === true,
    sandbox_warning: live?.sandbox?.warning ?? wrapped.warning ?? null,
    argv: dryRun
      ? wrapped.argv
      : prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(state.runId), {
          probe,
        }).argv,
    permissions: effectivePerms,
    budget: st.budget,
  };
}

/** Alias used by production entrypoint tests. */
export const launchSpecialist = launch;

export async function runSpecialist(args, io = { out: console.log, err: console.error }) {
  const id = argValue(args, "--id") || args[0];
  const callType = argValue(args, "--call-type") || "delegate";
  const project = argValue(args, "--project") || process.cwd();
  const objective = argValue(args, "--objective") || "";
  const dryRun = args.includes("--dry-run");
  if (!id || !objective) {
    io.err("usage: team-up specialist run --id <id> --call-type <consult|delegate|review> --objective <text> --project <path>");
    return { code: 1 };
  }
  try {
    const result = await launch({
      specialistId: id,
      callType,
      objective,
      project,
      dryRun,
    });
    io.out(`run_id: ${result.runId}`);
    io.out(`cli: ${result.runtime.cli}`);
    io.out(`model: ${result.runtime.model}`);
    if (result.runtime.effort != null && result.runtime.effort !== "") {
      io.out(`effort: ${result.runtime.effort}`);
    }
    if (dryRun) io.out("dry_run: true");
    else io.out(`watcher: team-up runs wait ${result.runId}`);
    return { code: 0, result };
  } catch (e) {
    io.err(String(e.message || e));
    return { code: e.code === "PROFILE_UNAVAILABLE" ? 2 : 1, error: e };
  }
}
