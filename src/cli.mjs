export const VERSION = "0.7.0";

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pick } from "./roster/chain.mjs";
import { loadJson, configPath, usagePath, requireRoster, validateRoster, saveRoster } from "./roster/config.mjs";
import { runRosterCli } from "./roster/roster.mjs";
import {
  validateManifest,
  inspectPackage,
  installPackage,
  listInstalled,
  loadInstalledManifest,
  uninstallSpecialist,
} from "./specialists/store.mjs";
import { trustProjectPolicy } from "./specialists/approvals.mjs";
import { runSpecialist } from "./specialists/launcher.mjs";
import { loadEvalSuite, runEvalSuite } from "./specialists/evals.mjs";
import { runHarnessVerify } from "./harness/cli-verify.mjs";
import { diagnose } from "./doctor.mjs";
import { runCapabilityCli } from "./capabilities/cli.mjs";
import { runTelemetryCli } from "./telemetry/cli.mjs";
import { runAdmissionCli } from "./admission/cli.mjs";
import { startDashboard } from "./dashboard/server.mjs";
import { runModelsScan } from "./commands/models-scan.mjs";
import { runModelsList } from "./commands/models-list.mjs";
import { defaultRun } from "./collectors/cli-models.mjs";
import { loadModelsStore } from "./collectors/models-store.mjs";
import { bringToLatest } from "./roster/latest.mjs";

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function pickJsonPayload({ model, cli, effort, skipped, quota_blocked = [] }) {
  return {
    model: model ?? null,
    cli: cli ?? null,
    effort: effort ?? null,
    skipped,
    quota_blocked,
  };
}

async function cmdPick(args, io) {
  const json = args.includes("--json");
  const role = argValue(args, "--role");
  if (role) {
    const roster = requireRoster();
    const usage = loadJson(usagePath());
    const r = pick({ roster, usage, role });
    if (!json) {
      for (const s of r.skipped) io.out(`skipped ${s.model}: ${s.reason}`);
    }
    if (!r.model) {
      if (json) {
        io.out(JSON.stringify(pickJsonPayload({
          model: null,
          cli: null,
          effort: null,
          skipped: r.skipped,
          quota_blocked: [],
        })));
      } else {
        io.err(`chain exhausted for role ${role} — no viable model`);
      }
      return 2;
    }
    if (json) {
      io.out(JSON.stringify(pickJsonPayload({
        model: r.model,
        cli: r.cli,
        effort: r.effort,
        skipped: r.skipped,
        quota_blocked: [],
      })));
      return 0;
    }
    io.out(`model: ${r.model}`);
    io.out(`cli: ${r.cli}`);
    if (r.effort) io.out(`effort: ${r.effort}`);
    return 0;
  }
  io.err("usage: team-up pick --role <role> [--json]");
  return 1;
}

async function cmdModels(args, io) {
  const [sub, ...rest] = args;
  if (sub === "scan") {
    const roster = requireRoster();
    return runModelsScan(rest, io, { roster, run: defaultRun });
  }
  if (sub === "list") {
    return runModelsList(rest, io);
  }
  if (sub === "latest") {
    // Moves chain entries to the newest version the last fresh scan lists.
    // Dry run unless --apply; pinned entries (`"pinned": true`) never move.
    const { next, added, changes, removed } = bringToLatest(requireRoster(), loadModelsStore());
    for (const a of added) io.out(`new model ${a.id} on ${a.cli} (copied from ${a.from})`);
    for (const c of changes) io.out(`${c.role}: ${c.cli}:${c.from} → ${c.to} (${c.reason})`);
    for (const r of removed) io.out(`removed ${r.id} from ${r.cli} (gone, no chain names it)`);
    if (!changes.length && !added.length && !removed.length) io.out("every chain is on the newest offered version");
    else if (rest.includes("--apply")) io.out(`applied · backup ${saveRoster(next).backup}`);
    else io.out("dry run — add --apply to write roster.json");
    return 0;
  }
  io.err("usage: team-up models scan|list|latest [--cli <id>] [--json] [--apply]");
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
    if (!pathArg || rest.length !== 1) {
      io.err("usage: team-up specialist install <path>");
      return 1;
    }
    const result = await installPackage(pathArg);
    io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (sub === "trust-policy") {
    const project = argValue(rest, "--project");
    if (!project || !path.isAbsolute(project)) {
      io.err("usage: team-up specialist trust-policy --project <absolute-path>");
      return 1;
    }
    const result = trustProjectPolicy({ project });
    io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (sub === "uninstall") {
    const [id, version] = String(rest[0] ?? "").split("@");
    if (!id || !version) {
      io.err("usage: team-up specialist uninstall <id>@<version>");
      return 1;
    }
    const result = uninstallSpecialist(id, { version });
    io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (sub === "list") {
    io.out(JSON.stringify(listInstalled(), null, 2));
    return 0;
  }
  if (sub === "evals") {
    const targets = rest[0] && !rest[0].startsWith("--")
      ? [rest[0]]
      : Object.keys(listInstalled().specialists ?? {});
    if (!targets.length) {
      io.err("no specialists installed");
      return 1;
    }
    const reports = [];
    for (const target of targets) {
      const [id, version] = String(target).split("@");
      const entry = loadInstalledManifest(id, version ? { version } : {});
      if (!entry) {
        reports.push({ specialist: target, ok: false, error: "not installed" });
        continue;
      }
      const suite = loadEvalSuite(entry.manifest, entry.path);
      if (!suite.ok) {
        reports.push({ specialist: target, ok: false, error: suite.error });
        continue;
      }
      reports.push(runEvalSuite({
        manifest: entry.manifest,
        suite,
        specialistId: entry.manifest.id,
      }));
    }
    io.out(JSON.stringify({ suites: reports }, null, 2));
    return reports.every((r) => r.ok) ? 0 : 1;
  }
  if (sub === "run") {
    const result = await runSpecialist(rest, io);
    return result.code;
  }
  io.err("usage: team-up specialist <inspect|install|trust-policy|uninstall|list|evals|run>");
  return 1;
}

export async function runCli(args, io = { out: console.log, err: console.error }) {
  const [cmd, ...rest] = args;
  if (cmd === "version" || cmd === "--version") {
    io.out(VERSION);
    return 0;
  }
  if (cmd === "models") return cmdModels(rest, io);
  if (cmd === "validate") return cmdValidate(rest, io);
  if (cmd === "pick") return cmdPick(rest, io);
  if (cmd === "runs") return cmdRuns(rest, io);
  if (cmd === "doctor") {
    // Real runner: doctor stays hermetic when called without one (tests), and
    // the CLI is the caller that may spawn `<cli> models` and `<cli> --version`.
    const report = diagnose(process.env, { execFileSync });
    io.out(JSON.stringify(report, null, 2));
    // A stale exclusion delivers a capability that was meant to be denied, so
    // high findings are an error; the rest are reported without failing.
    return report.counts.high > 0 ? 1 : 0;
  }
  if (cmd === "specialist") return cmdSpecialist(rest, io);
  if (cmd === "capability") return runCapabilityCli(rest, io);
  if (cmd === "telemetry") return runTelemetryCli(rest, io);
  if (cmd === "admission") return runAdmissionCli(rest, io);
  if (cmd === "harness") {
    const [sub, ...harnessArgs] = rest;
    if (sub === "verify") return runHarnessVerify(harnessArgs, io);
    io.err("usage: team-up harness verify <claude> [--fixture-project <path>]");
    return 1;
  }
  if (cmd === "dashboard") {
    const port = Number(argValue(rest, "--port") || 8556);
    const host = argValue(rest, "--host") || "127.0.0.1";
    const rotateToken = rest.includes("--rotate-token");
    const allowInstall = rest.includes("--allow-install");
    const requireAdminConfirm = rest.includes("--require-admin-confirm");
    const publicOrigin = argValue(rest, "--public-origin") || "";
    const usage =
      "usage: team-up dashboard [--port N] [--host H] [--rotate-token] "
      + "[--allow-install] [--require-admin-confirm] "
      + "[--public-origin https://host[,https://other]]";
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
      io.err(usage);
      return 1;
    }
    const originParts = publicOrigin.split(",").map((o) => o.trim()).filter(Boolean);
    if (originParts.some((o) => !/^https?:\/\/[^/\s]+$/.test(o))) {
      io.err("--public-origin takes scheme://host[:port], comma-separated, no paths");
      return 1;
    }
    await startDashboard({
      host, port, rotateToken, allowInstall, requireAdminConfirm, publicOrigin, io,
    });
    return 0;
  }
  if (
    [
      "init",
      "dispatch",
      "mark-limited",
      "usage",
    ].includes(cmd)
  ) {
    // Preserve roster CLI surface through the facade (uses console directly).
    return runRosterCli(args);
  }
  io.err(
    "usage: team-up <version|init|validate|doctor|pick|models|dispatch|mark-limited|usage|runs|specialist|capability|telemetry|admission|harness|dashboard>"
  );
  return 1;
}
