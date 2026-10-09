import fs from "node:fs";
import path from "node:path";
import { loadInstalledManifest, verifyInstalledIntegrity } from "./store.mjs";
import { isPolicyTrusted } from "./approvals.mjs";
import { normalizeRequest } from "./request.mjs";
import {
  intersectPermissions,
  assertCallTypeAllowed,
  builtinsForPermissions,
} from "./permissions.mjs";
import { resolveProfile } from "../roster/profile.mjs";
import { requireRoster, loadJson, usagePath } from "../roster/config.mjs";
import { buildCommand, startInTmux } from "../roster/command.mjs";
import { recordPick } from "../roster/roster.mjs";
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
import { normalizeBudget } from "./budget.mjs";
import {
  resolveCommandPolicyForApproval,
  snapshotCommandPolicy,
} from "../commands/policy.mjs";
import {
  defaultHarnessCapabilities,
  prepareHarnessLaunch,
  getAdapter,
  harnessStatus,
  injectAdapterEnv,
} from "../harness/registry.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../harness/capabilities.mjs";
import { loadAssignments } from "../capabilities/assignments.mjs";
import {
  listInstalledCapabilities,
  verifyInstalledCapability,
} from "../capabilities/store.mjs";
import { resolveCapabilities } from "../capabilities/resolve.mjs";
import {
  materializeCapabilityCapsule,
  buildStrictMcpConfig,
  collectCapsuleMcpTools,
  autoInvokePrefix,
  capsuleContextDir,
} from "../capabilities/capsule.mjs";
import { atomicWriteJson } from "../json-store.mjs";
import { detectParent } from "../runs/parent.mjs";

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

export { builtinsForPermissions };

/**
 * A one-off {cli, model} for this launch. A named model replaces the
 * specialist's chain with that one cell; a bare cli filters the chain down to
 * it. Account, harness capability and usage gates run unchanged, so an
 * override can only pick something the gates already allowed.
 */
export function resolveRuntimeOverride(roster, runtime) {
  const cli = runtime?.cli || null;
  const model = runtime?.model || null;
  if (!cli && !model) return null;
  if (model && !roster?.models?.[model]) {
    const err = new Error(`unknown model: ${model}`);
    err.code = "RUNTIME_OVERRIDE_UNKNOWN";
    throw err;
  }
  if (cli && !roster?.clis?.[cli]?.cmd) {
    const err = new Error(`unknown cli: ${cli}`);
    err.code = "RUNTIME_OVERRIDE_UNKNOWN";
    throw err;
  }
  return { cli, model };
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
  permissions,
  runtime = null,
  env = process.env,
  dryRun = false,
  // "check": refuse with ADMISSION_REFUSED; "force": start regardless.
  admission = "check",
  dependencyOverrides = {},
}) {
  const resolveEffectiveCapabilities =
    dependencyOverrides.resolveEffectiveCapabilities ??
    (() => {
      const resolution = resolveCapabilities({
        specialistId,
        assignments: loadAssignments({ env }).assignments,
        installed: listInstalledCapabilities({ env }),
      });
      for (const item of resolution.packages) verifyInstalledCapability(item);
      return resolution;
    });
  const materializeCapabilityCapsuleFn =
    dependencyOverrides.materializeCapabilityCapsule ?? materializeCapabilityCapsule;
  const createRunFn = dependencyOverrides.createRun ?? createRun;
  const detectParentFn = dependencyOverrides.detectParent ?? detectParent;
  const startInTmuxFn = dependencyOverrides.startInTmux ?? startInTmux;
  const harnessCapabilitiesFn =
    dependencyOverrides.harnessCapabilities ?? defaultHarnessCapabilities;
  const harnessStatusFn = dependencyOverrides.harnessStatus ?? harnessStatus;
  const prepareHarnessLaunchFn =
    dependencyOverrides.prepareHarnessLaunch ?? prepareHarnessLaunch;
  const checkAdmissionFn = dependencyOverrides.checkAdmission ?? defaultCheckAdmission;

  // Install trust and permission gates stay ordered before launch setup below.
  const installed = loadInstalledManifest(specialistId, { env });
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
  // A project with no command policy at all (docs, a static site, a repo
  // without tests) still gets the specialist — without its command tools.
  // That only ever removes power; an invalid or incomplete policy still fails.
  let commandsUnavailable = false;
  try {
    ({ checksum: commandPolicyChecksum, policy: projectPolicy } = resolveCommandPolicyForApproval({
      project,
      permissions: manifest.permissions,
      env,
    }));
  } catch (e) {
    if (e.code === "COMMAND_POLICY_MISSING") {
      commandsUnavailable = true;
    } else {
      e.code = e.code || "COMMAND_POLICY_INVALID";
      throw e;
    }
  }

  if (commandPolicyChecksum && !isPolicyTrusted({ checksum: commandPolicyChecksum, env })) {
    const err = new Error(
      `project command policy is not trusted; run team-up specialist trust-policy --project ${path.resolve(project)}`
    );
    err.code = "COMMAND_POLICY_UNTRUSTED";
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

  if (commandsUnavailable) effectivePerms = { ...effectivePerms, commands: [] };

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
    ...((effectivePerms.commands || []).length > 0
      ? { command_broker: "team-up.command-broker/v1" } : {}),
  };
  const runtimeOverride = resolveRuntimeOverride(roster, runtime);
  const pickCell = () => {
    const profileResult = resolveProfile({
      roster,
      usage,
      specialistId,
      requirements,
      harnessCapabilities: harnessCapabilitiesFn,
      override: runtimeOverride,
    });
    // A named model resolves to that one cell; when a gate drops it, the
    // refusal below names the override, not the specialist's chain.
    if (profileResult.code !== "OK" && !runtimeOverride?.model) {
      const err = new Error(`PROFILE_UNAVAILABLE: ${JSON.stringify(profileResult.skipped.slice(0, 5))}`);
      err.code = "PROFILE_UNAVAILABLE";
      err.details = profileResult;
      return { profileResult, cell: null, err };
    }
    const cell = runtimeOverride
      ? profileResult.chain.find((c) =>
          (!runtimeOverride.model || c.model === runtimeOverride.model)
          && (!runtimeOverride.cli || c.cli === runtimeOverride.cli))
      : profileResult.chain[0];
    // A named cell that no gate let through is a refusal, not a silent fallback
    // to whatever the chain offered instead: the caller asked for that one.
    if (!cell) {
      const want = [runtimeOverride?.cli, runtimeOverride?.model].filter(Boolean).join(":");
      // Why the asked-for cell was dropped comes first.
      const mine = profileResult.skipped.filter((sk) =>
        !runtimeOverride?.model || String(sk.model).endsWith(runtimeOverride.model));
      const err = new Error(
        `RUNTIME_OVERRIDE_UNAVAILABLE: ${want} — ${JSON.stringify((mine.length ? mine : profileResult.skipped).slice(0, 5))}`,
      );
      err.code = "RUNTIME_OVERRIDE_UNAVAILABLE";
      err.details = profileResult;
      return { profileResult, cell: null, err };
    }
    return { profileResult, cell, err: null };
  };

  const { profileResult, cell, err: cellErr } = pickCell();
  if (cellErr) throw cellErr;
  // Record the assignment profile, or the exact one-cell runtime override.
  const launchedProfile = runtimeOverride?.model
    ? { chain: [{ model: cell.model, cli: cell.cli }] }
    : profileResult.profile;

  if (admission !== "check" && admission !== "force") {
    const err = new Error("unsupported admission mode; use check or force");
    err.code = "ADMISSION_MODE_UNSUPPORTED";
    throw err;
  }

  // Match dispatch: admission precedes run creation, so refusal leaves no run.
  let admissionRecord = null;
  if (dryRun) {
    admissionRecord = { skipped: "dry_run", at: new Date().toISOString() };
  } else if (admission === "force") {
    admissionRecord = { forced: true, at: new Date().toISOString() };
  } else {
    const decision = await checkAdmissionFn({ cli: cell.cli, env });
    admissionRecord = { ok: decision.ok, reason: decision.reason ?? null, at: new Date().toISOString() };
    if (!decision.ok) {
      const err = new Error(`ADMISSION_REFUSED: ${decision.reason}`);
      err.code = "ADMISSION_REFUSED";
      err.details = decision;
      throw err;
    }
  }
  const verification = harnessStatusFn(cell.cli, { env });
  const verificationNeedsWarning = ["no_record", "failed", "drifted"].includes(verification.status);
  const harnessWarning = verificationNeedsWarning
    ? `${cell.cli} ${verification.installed_version} harness verification ${verification.status}; launch continues. Run team-up harness verify ${cell.cli}.`
    : null;

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
    // No path here: this text is built before the run id exists, so it could
    // only name a relative one — and the worker's cwd is the context dir, not
    // the run dir. The mailbox protocol appended below carries the absolute
    // paths and is the authority.
    "Report through the mailbox protocol below. RESULT.json conforming to schema team-up.result/v1 is the deliverable.",
    "Its status field must be one of success, partial, blocked, failed — not done.",
    "RESULT.md is optional human-readable detail and does not count as success by itself.",
    budgetNorm.tokens
      ? `Advisory token target: ${budgetNorm.tokens.target} (not hard-enforced).`
      : null,
    budgetNorm.timeout_seconds
      ? `Timeout budget: ${budgetNorm.timeout_seconds}s (enforced by timeout(1)).`
      : null,
  ].filter(Boolean).join("\n");

  const state = createRunFn({
    cwd: runCwd || undefined,
    project: fsMode === "none" ? null : project,
    role: `specialist:${specialistId}`,
    parent: detectParentFn({ env }),
    worker: { cli: cell.cli, model: cell.model },
    prompt: barePrompt,
    result_protocol: "RESULT.json",
  });

  // Anything that throws once the run exists leaves it failed, not starting.
  try {
    const st = loadState(state.runId);
    st.specialist = {
      id: specialistId,
      version: installed.version,
      checksum: installed.checksum,
    };
    if (harnessWarning) st.harness_warning = harnessWarning;
    saveState(st);
    if (harnessWarning) console.error(`warning: ${harnessWarning}`);

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
      // Explicit, though it is also the default: this is the call site an
      // orchestrator has to change to `parent.depth + 1`, and `normalizeRequest`
      // caps it at `MAX_DEPTH`. Leaving the field out hides where the increment
      // belongs.
      depth: 0,
    });
    request.run_id = state.runId;

    const launchState = loadState(state.runId);
    launchState.budget = {
      timeout_seconds: budgetNorm.timeout_seconds,
      tokens: budgetNorm.tokens,
      warnings: budgetNorm.warnings,
    };
    launchState.command_policy = policySnapshot
      ? { checksum: policySnapshot.checksum, snapshot: policySnapshot.path }
      : { checksum: null, snapshot: null };
    launchState.output_contract = "team-up.result/v1";
    launchState.result_protocol = "RESULT.json";
    if (admissionRecord) launchState.admission = admissionRecord;
    saveState(launchState);

    const dest = capsuleContextDir(runDir(state.runId));
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
        // The worker's cwd; the isolation canary probes from the same layout.
        contextDir: dest,
        homeDir: path.join(runDir(state.runId), "harness", "home"),
        codexHome: path.join(runDir(state.runId), "harness", "home"),
        // Directories the worker actually opens. Harnesses that gate on workspace
        // trust need these pre-accepted, or the launch stalls on a prompt nobody
        // is there to answer.
        workspaceDirs: [
          dest,
          ...(runCwd ? [runCwd] : []),
        ],
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
      setStatus(state.runId, "failed", { reason: `capsule setup: ${e.message}` });
      throw e;
    }

    atomicWriteJson(path.join(runDir(state.runId), "mailbox", "REQUEST.json"), request);

    let autoInvoke;
    try {
      autoInvoke = autoInvokePrefix(effective, skillInvocationFor(cell.cli));
    } catch (e) {
      setStatus(state.runId, "failed", { reason: `capsule setup: ${e.message}` });
      throw e;
    }
    // Prefixed after wrapping: the invocation has to be the first thing the
    // harness reads, ahead of the mailbox protocol.
    const workerPrompt = autoInvoke.prefix + wrapPromptWithMailboxProtocol(barePrompt, {
      runId: state.runId,
      runDirectory: runDir(state.runId),
      resultProtocol: "RESULT.json",
    });
    atomicWriteText(path.join(runDir(state.runId), "mailbox", "PROMPT.md"), workerPrompt);
    if (autoInvoke.skills.length) {
      const stInvoke = loadState(state.runId);
      stInvoke.auto_invoke = {
        skills: autoInvoke.skills,
        applied: autoInvoke.prefix !== "",
        ...(autoInvoke.skipped ? { skipped: autoInvoke.skipped } : {}),
      };
      saveState(stInvoke);
    }

    const cliArgvRaw = buildCommand({
      roster,
      model: cell.model,
      cli: cell.cli,
      prompt: workerPrompt,
      effort: cell.effort,
      dir: dest,
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
      allowedBuiltins: builtinsForPermissions(effectivePerms),
      env,
    });
    const timeoutSeconds = budgetNorm.timeout_seconds ?? 0;
    const argv = [
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      `${timeoutSeconds}s`,
      ...injectAdapterEnv(prepared.argv, prepared.env),
    ];
    const limitWindows = resolveLimitWindowsForCell(cell, roster);

    const stAfter = loadState(state.runId);
    stAfter.harness_requirements = requirements;
    stAfter.specialist_profile = launchedProfile;
    stAfter.runtime = {
      cli: cell.cli,
      model: cell.model,
      effort: cell.effort,
      limit_windows: limitWindows,
    };
    stAfter.budget = launchState.budget;
    stAfter.command_policy = launchState.command_policy;
    stAfter.output_contract = launchState.output_contract;
    stAfter.result_protocol = launchState.result_protocol;
    saveState(stAfter);

    if (!dryRun) {
      const session = `team-up-${specialistId.replace(/[^a-z0-9]+/gi, "-")}-${Date.now().toString(36)}`;
      try {
        startInTmuxFn({ session, dir: dest, argv, runId: state.runId });
      } catch (error) {
        setStatus(state.runId, "failed", { reason: `tmux start: ${error?.message || error}` });
        throw error;
      }
      linkDispatchToRun(state.runId, session);
      recordPick(state.runId, {
        cli: cell.cli,
        model: cell.model,
        effort: cell.effort ?? null,
        pinned: Boolean(runtimeOverride),
        skipped: profileResult.skipped,
        refresh: null,
      });
    } else {
      const dryState = loadState(state.runId);
      dryState.dry_run = true;
      saveState(dryState);
      setStatus(state.runId, "cancelled");
    }

    return {
      runId: state.runId,
      ...(admissionRecord?.forced ? { admission_forced: true } : {}),
      runtime: {
        cli: cell.cli,
        model: cell.model,
        effort: cell.effort,
        limit_windows: limitWindows,
      },
      argv,
      permissions: effectivePerms,
      budget: launchState.budget,
      ...(harnessWarning ? { harness_warning: harnessWarning } : {}),
    };
  } catch (error) {
    const current = loadState(state.runId);
    if (current && current.status !== "failed" && current.status !== "cancelled") {
      setStatus(state.runId, "failed", { reason: `launch: ${error?.message || error}` });
    }
    throw error;
  }
}

async function defaultCheckAdmission({ cli, env }) {
  const { checkAdmission } = await import("../admission/admission.mjs");
  return checkAdmission({ cli, env });
}

function resolveLimitWindowsForCell(cell, roster) {
  const model = roster?.models?.[cell?.model];
  if (Array.isArray(cell?.limit_windows) && cell.limit_windows.length) return cell.limit_windows;
  return Array.isArray(model?.limit_windows) ? model.limit_windows : [];
}

/** Alias used by production entrypoint tests. */
export const launchSpecialist = launch;

function skillInvocationFor(cli) {
  let adapter;
  try {
    adapter = getAdapter(cli);
  } catch {
    return null;
  }
  return typeof adapter.skillInvocation === "function"
    ? (name) => adapter.skillInvocation(name)
    : null;
}

export async function runSpecialist(args, io = { out: console.log, err: console.error }, { launchFn = launch } = {}) {
  const id = argValue(args, "--id") || args[0];
  const callType = argValue(args, "--call-type") || "delegate";
  const project = argValue(args, "--project") || process.cwd();
  const objective = argValue(args, "--objective") || "";
  const dryRun = args.includes("--dry-run");
  const runtime = { cli: argValue(args, "--cli"), model: argValue(args, "--model") };
  if (args.includes("--wait-capacity")) {
    io.err("unsupported admission option; retry after capacity is available or pass --force-admission");
    return { code: 1 };
  }
  const admission = args.includes("--force-admission") ? "force" : "check";
  if (!id || !objective) {
    io.err("usage: team-up specialist run --id <id> --call-type <consult|delegate|review> --objective <text> --project <path> [--cli <cli>] [--model <model>] [--force-admission]");
    return { code: 1 };
  }
  try {
    const result = await launchFn({
      specialistId: id,
      callType,
      objective,
      project,
      runtime,
      dryRun,
      admission,
    });
    io.out(`run_id: ${result.runId}`);
    io.out(`cli: ${result.runtime.cli}`);
    io.out(`model: ${result.runtime.model}`);
    io.out(`argv: ${JSON.stringify(result.argv)}`);
    if (result.runtime.effort != null && result.runtime.effort !== "") {
      io.out(`effort: ${result.runtime.effort}`);
    }
    if (result.waiting_capacity) io.out(`status: waiting_capacity (${result.waiting_capacity})`);
    if (result.admission_forced) io.out("admission: forced");
    if (dryRun) io.out("dry_run: true");
    else io.out(`watcher: team-up runs wait ${result.runId}`);
    return { code: 0, result };
  } catch (e) {
    io.err(String(e.message || e));
    if (e.code === "ADMISSION_REFUSED") return { code: 3, error: e };
    const unavailable = e.code === "PROFILE_UNAVAILABLE" || e.code === "RUNTIME_OVERRIDE_UNAVAILABLE";
    return { code: unavailable ? 2 : 1, error: e };
  }
}
