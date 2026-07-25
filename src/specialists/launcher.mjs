import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadInstalledManifest } from "./store.mjs";
import { isApproved } from "./approvals.mjs";
import { normalizeRequest } from "./request.mjs";
import { resolveProfile } from "../roster/profile.mjs";
import { requireRoster, loadJson, usagePath } from "../roster/config.mjs";
import { buildCommand, tmuxArgs } from "../roster/command.mjs";
import { createRun, runDir, wrapPromptWithMailboxProtocol, atomicWriteText, linkDispatchToRun } from "../runs/runs.mjs";
import { materialize } from "../sandbox/materialize.mjs";
import { wrapWithSandbox } from "../sandbox/systemd.mjs";
import { atomicWriteJson } from "../json-store.mjs";

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
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
  sandbox = { available: true },
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

  const request = normalizeRequest({
    specialist_id: specialistId,
    specialist_version: installed.version,
    call_type: callType,
    objective,
    inputs,
    permissions: permissions || manifest.permissions,
    budget: manifest.budget,
  });

  const effectivePerms = request.permissions;
  // Merge filesystem/network from manifest
  const mergedPerms = {
    ...manifest.permissions,
    ...effectivePerms,
  };


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
    "Write mailbox/RESULT.json with schema team-up.result/v1 when done.",
  ].join("\n");

  const state = createRun({
    cwd: project,
    project,
    role: `specialist:${specialistId}`,
    parent: { cli: "team-up", attach: "manual" },
    worker: { cli: cell.cli, model: cell.model },
    prompt: barePrompt,
  });
  request.run_id = state.runId;

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

  const wrapped = wrapWithSandbox({
    command: cliArgv,
    permissions: mergedPerms,
    cwd: dest,
    writablePaths: [runDir(state.runId), dest],
    probe: () => sandbox?.available !== false && (sandbox?.probe ? sandbox.probe() : true),
  });

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
