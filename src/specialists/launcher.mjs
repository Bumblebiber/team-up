import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadInstalledManifest } from "./store.mjs";
import { isApproved } from "./approvals.mjs";
import { normalizeRequest } from "./request.mjs";
import { intersectPermissions, assertCallTypeAllowed } from "./permissions.mjs";
import { resolveProfile } from "../roster/profile.mjs";
import { requireRoster, loadJson, usagePath } from "../roster/config.mjs";
import { buildCommand, tmuxArgs } from "../roster/command.mjs";
import { createRun, runDir, wrapPromptWithMailboxProtocol, atomicWriteText, linkDispatchToRun, saveState, loadState } from "../runs/runs.mjs";
import { materialize } from "../sandbox/materialize.mjs";
import { wrapWithSandbox, systemdAvailable } from "../sandbox/systemd.mjs";
import { atomicWriteJson } from "../json-store.mjs";

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function resolveCliPath(argv0) {
  if (!argv0) return null;
  if (path.isAbsolute(argv0) && fs.existsSync(argv0)) return argv0;
  try {
    const which = execFileSync("which", [argv0], { encoding: "utf8" }).trim();
    return which || null;
  } catch {
    return null;
  }
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
}) {
  if (sandbox?.available === false) {
    const err = new Error("SANDBOX_UNAVAILABLE");
    err.code = "SANDBOX_UNAVAILABLE";
    throw err;
  }
  const installed = loadInstalledManifest(specialistId, env);
  if (!installed) {
    const err = new Error(`specialist not installed: ${specialistId}`);
    err.code = "NOT_INSTALLED";
    throw err;
  }
  const manifest = installed.manifest;
  try {
    assertCallTypeAllowed(callType, manifest);
  } catch (e) {
    e.code = "CALL_TYPE_DENIED";
    throw e;
  }

  if (!isApproved({
    project,
    id: specialistId,
    version: installed.version,
    checksum: installed.checksum,
    permissions: manifest.permissions,
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

  // Validate tool/command allowlists at launch — undeclared materialization prevented in materialize
  const allowedCommands = new Set(manifest.permissions?.commands || []);
  for (const c of effectivePerms.commands || []) {
    if (!allowedCommands.has(c)) {
      const err = new Error(`undeclared command in launch allowlist: ${c}`);
      err.code = "ALLOWLIST_VIOLATION";
      throw err;
    }
  }

  const request = normalizeRequest({
    specialist_id: specialistId,
    specialist_version: installed.version,
    call_type: callType,
    objective,
    inputs,
    permissions: effectivePerms,
    budget: manifest.budget,
  });

  const roster = requireRoster();
  const usage = loadJson(usagePath());
  const profileResult = resolveProfile({
    roster,
    usage,
    profile: manifest.model_profile,
    specialistId,
    callType,
  });
  if (profileResult.code !== "OK") {
    const err = new Error(`PROFILE_UNAVAILABLE: ${JSON.stringify(profileResult.skipped.slice(0, 5))}`);
    err.code = "PROFILE_UNAVAILABLE";
    err.details = profileResult;
    throw err;
  }
  const cell = profileResult.chain[0];

  const barePrompt = [
    `# Specialist ${manifest.display_name} (${callType})`,
    "",
    `Objective: ${objective}`,
    "",
    "Read REQUEST.json and instructions.md in the context directory. Follow remit/anti-remit.",
    "Write mailbox/RESULT.json conforming to schema team-up.result/v1 when done.",
    "RESULT.md is optional human-readable detail and does not count as success by itself.",
    manifest.budget?.max_tokens
      ? `Token budget: ${manifest.budget.max_tokens}. Stay within budget.`
      : null,
    manifest.budget?.timeout_seconds
      ? `Timeout budget: ${manifest.budget.timeout_seconds}s (enforced by sandbox runtime).`
      : null,
  ].filter(Boolean).join("\n");

  const state = createRun({
    cwd: project,
    project,
    role: `specialist:${specialistId}`,
    parent: { cli: "team-up", attach: "manual" },
    worker: { cli: cell.cli, model: cell.model },
    prompt: barePrompt,
  });
  request.run_id = state.runId;

  // Carry budgets into state metadata / worker contract
  const st = loadState(state.runId);
  st.budget = {
    timeout_seconds: manifest.budget?.timeout_seconds ?? null,
    max_tokens: manifest.budget?.max_tokens ?? null,
  };
  st.output_contract = "team-up.result/v1";
  st.result_protocol = "RESULT.json";
  saveState(st);

  const dest = path.join(runDir(state.runId), "context");
  await materialize({
    packageDir: installed.path,
    request,
    destination: dest,
    manifest,
    projectRoot: project,
    inputs,
  });

  atomicWriteJson(path.join(runDir(state.runId), "mailbox", "REQUEST.json"), request);

  const workerPrompt = wrapPromptWithMailboxProtocol(barePrompt, {
    runId: state.runId,
    runDirectory: runDir(state.runId),
  });
  atomicWriteText(path.join(runDir(state.runId), "mailbox", "PROMPT.md"), workerPrompt);

  const cliArgv = buildCommand({
    roster,
    model: cell.model,
    cli: cell.cli,
    prompt: workerPrompt,
    effort: cell.effort,
  });

  const cliPath = resolveCliPath(cliArgv[0]);
  const runPath = runDir(state.runId);
  const timeoutSec = manifest.budget?.timeout_seconds;

  const probe = sandbox?.probe
    ? sandbox.probe
    : systemdAvailable;

  const wrapped = wrapWithSandbox({
    command: cliArgv,
    permissions: effectivePerms,
    cwd: dest,
    writablePaths: [runPath, dest],
    readOnlyPaths: cliPath ? [cliPath] : [],
    callType,
    projectPath: project,
    packagePath: installed.path,
    runPath,
    cliPath,
    writableProject:
      callType === "delegate" &&
      (effectivePerms.writes === "delegated_only" || effectivePerms.writes === true) &&
      effectivePerms.filesystem === "project",
    probe,
    timeoutSeconds: timeoutSec,
  });

  // Enforce timeout via sandbox RuntimeMaxSec when provided
  if (timeoutSec && wrapped.sandbox === "systemd-run-user") {
    const idx = wrapped.argv.indexOf("--");
    if (idx !== -1) {
      wrapped.argv.splice(idx, 0, "-p", `RuntimeMaxSec=${timeoutSec}`);
    }
  }

  if (!dryRun) {
    const session = `team-up-${specialistId.replace(/[^a-z0-9]+/gi, "-")}-${Date.now().toString(36)}`;
    execFileSync("tmux", tmuxArgs({ session, dir: dest, argv: wrapped.argv }), { stdio: "inherit" });
    linkDispatchToRun(state.runId, session);
  }

  return {
    runId: state.runId,
    runtime: { cli: cell.cli, model: cell.model, effort: cell.effort },
    sandbox: wrapped.sandbox,
    argv: wrapped.argv,
    permissions: effectivePerms,
    budget: st.budget,
  };
}

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
    io.out(`watcher: team-up runs wait ${result.runId}`);
    return { code: 0, result };
  } catch (e) {
    io.err(String(e.message || e));
    return { code: e.code === "PROFILE_UNAVAILABLE" ? 2 : 1, error: e };
  }
}
