export const VERSION = "0.1.0";

import { pick } from "./roster/chain.mjs";
import { loadJson, configPath, usagePath, requireRoster, validateRoster } from "./roster/config.mjs";
import { resolveProfile, parseProfileString } from "./roster/profile.mjs";
import { runRosterCli } from "./roster/roster.mjs";
import {
  validateManifest,
  inspectPackage,
  installPackage,
  listInstalled,
} from "./specialists/store.mjs";
import { approveSpecialist, listApprovals } from "./specialists/approvals.mjs";
import { runSpecialist } from "./specialists/launcher.mjs";
import { runHarnessVerify } from "./harness/cli-verify.mjs";
import { runCapabilityCli } from "./capabilities/cli.mjs";

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

async function cmdPick(args, io) {
  const profileStr = argValue(args, "--profile");
  const role = argValue(args, "--role");
  if (profileStr) {
    const profile = parseProfileString(profileStr);
    const roster = requireRoster();
    const usage = loadJson(usagePath());
    const result = resolveProfile({ roster, usage, profile });
    for (const s of result.skipped) io.out(`skipped ${s.model}: ${s.reason}`);
    if (result.code !== "OK" || !result.chain.length) {
      io.err(`PROFILE_UNAVAILABLE for ${profile.tier}:${profile.reasoning}`);
      return 2;
    }
    const top = result.chain[0];
    io.out(`model: ${top.model}`);
    io.out(`cli: ${top.cli}`);
    if (top.effort != null && top.effort !== "") io.out(`effort: ${top.effort}`);
    return 0;
  }
  if (role) {
    // Delegate to roster pick via shared logic
    const roster = requireRoster();
    const usage = loadJson(usagePath());
    const r = pick({ roster, usage, role });
    for (const s of r.skipped) io.out(`skipped ${s.model}: ${s.reason}`);
    if (!r.model) {
      io.err(`chain exhausted for role ${role} — no viable model`);
      return 2;
    }
    io.out(`model: ${r.model}`);
    io.out(`cli: ${r.cli}`);
    if (r.effort) io.out(`effort: ${r.effort}`);
    return 0;
  }
  io.err("usage: team-up pick --role <role> | --profile <tier>:<reasoning>");
  return 1;
}

async function cmdValidate(args, io) {
  const roster = loadJson(configPath());
  if (!roster) {
    io.err(`no roster at ${configPath()}`);
    return 1;
  }
  const { errors, warnings } = validateRoster(roster);
  for (const w of warnings) io.err(`warning: ${w}`);
  for (const e of errors) io.err(`error: ${e}`);
  return errors.length ? 1 : 0;
}

async function cmdRuns(args, io) {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("./runs/runs.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
  if (r.stdout) io.out(r.stdout.trimEnd());
  if (r.stderr) io.err(r.stderr.trimEnd());
  return r.status ?? 1;
}

async function cmdSpecialist(args, io) {
  const [sub, ...rest] = args;
  if (sub === "inspect") {
    const pathArg = rest[0];
    if (!pathArg) {
      io.err("usage: team-up specialist inspect <path>");
      return 1;
    }
    const info = await inspectPackage(pathArg);
    io.out(JSON.stringify(info, null, 2));
    return info.ok ? 0 : 1;
  }
  if (sub === "install") {
    const pathArg = rest[0];
    if (!pathArg) {
      io.err("usage: team-up specialist install <path>");
      return 1;
    }
    const result = await installPackage(pathArg);
    io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (sub === "approve") {
    const idVer = rest[0];
    const project = argValue(rest, "--project");
    if (!idVer || !project) {
      io.err("usage: team-up specialist approve <id>@<version> --project <absolute-path>");
      return 1;
    }
    const result = await approveSpecialist({ idAtVersion: idVer, project });
    io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (sub === "list") {
    io.out(JSON.stringify(listInstalled(), null, 2));
    return 0;
  }
  if (sub === "run") {
    const result = await runSpecialist(rest, io);
    return result.code;
  }
  io.err("usage: team-up specialist <inspect|install|approve|list|run>");
  return 1;
}

export async function runCli(args, io = { out: console.log, err: console.error }) {
  const [cmd, ...rest] = args;
  if (cmd === "version" || cmd === "--version") {
    io.out(VERSION);
    return 0;
  }
  if (cmd === "validate") return cmdValidate(rest, io);
  if (cmd === "pick") return cmdPick(rest, io);
  if (cmd === "runs") return cmdRuns(rest, io);
  if (cmd === "specialist") return cmdSpecialist(rest, io);
  if (cmd === "capability") return runCapabilityCli(rest, io);
  if (cmd === "harness") {
    const [sub, ...harnessArgs] = rest;
    if (sub === "verify") return runHarnessVerify(harnessArgs, io);
    io.err("usage: team-up harness verify <claude> --fixture-project <path>");
    return 1;
  }
  if (
    [
      "init",
      "dispatch",
      "handoff",
      "pass-to",
      "mark-limited",
      "usage",
      "refresh",
      "propose",
      "apply-scores",
    ].includes(cmd)
  ) {
    // Preserve roster CLI surface through the facade (uses console directly).
    return runRosterCli(args);
  }
  io.err("usage: team-up <version|validate|pick|dispatch|runs|specialist|capability|harness>");
  return 1;
}
