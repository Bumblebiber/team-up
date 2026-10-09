import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listInstalled } from "./specialists/store.mjs";
import { listInstalledCapabilities } from "./capabilities/store.mjs";
import { loadAssignments } from "./capabilities/assignments.mjs";
import { HOST_TARGET } from "./capabilities/skill-scope.mjs";
import { loadInstalledManifest } from "./specialists/store.mjs";
import { resolveProfile } from "./roster/profile.mjs";
import {
  COMMAND_BROKER_CAPABILITY,
  CONTEXT_ISOLATION_CAPABILITY,
} from "./harness/capabilities.mjs";
import { configPath, loadJson, validateRoster } from "./roster/config.mjs";
import { defaultHarnessCapabilities, harnessStatus, listHarnessAdapters } from "./harness/registry.mjs";
import { checkModelAvailability } from "./roster/availability.mjs";
import { LIST_TIMEOUT_MS } from "./collectors/cli-models.mjs";
import { debugLogDir, telemetryDir } from "./paths.mjs";
import { journalPersistence, listRestartReports } from "./telemetry/restart.mjs";
import { FALLBACK_REMEDY, admissionConfig, deriveLimits } from "./admission/admission.mjs";
import { workerFootprint } from "./telemetry/stats.mjs";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Check every record keyed by a specialist id against what is actually
 * installed.
 *
 * Renaming a specialist renames the key all of these use, and none of them
 * error when it goes stale. An assignment whose `targets` names the old id
 * simply stops matching, so the capability quietly stops being delivered. In
 * `exclude` the same staleness is worse: the exclusion stops applying and the
 * package reaches a specialist that was meant to be denied it.
 */
export function diagnose(env = process.env, {
  execFileSync,
  journalStore = journalPersistence,
} = {}) {
  const findings = [];
  const installed = listInstalled(env).specialists ?? {};
  const ids = new Set(Object.keys(installed));

  const pool = new Set();
  for (const item of listInstalledCapabilities({ env })) {
    pool.add(`${item.package} ${item.checksum}`);
  }

  const assignments = loadAssignments({ env }).assignments ?? [];
  for (const row of assignments) {
    for (const field of ["targets", "exclude"]) {
      for (const target of row[field] ?? []) {
        if (target === "all") continue;
        if (field === "targets" && target === HOST_TARGET) continue;
        if (ids.has(target)) continue;
        findings.push({
          kind: "assignment_unknown_target",
          severity: field === "exclude" ? "high" : "medium",
          package: row.package,
          field,
          id: target,
          detail:
            field === "exclude"
              ? "exclusion names no installed specialist, so it denies nothing"
              : "assignment names no installed specialist, so it delivers nothing",
        });
      }
    }
    if (!pool.has(`${row.package} ${row.checksum}`)) {
      findings.push({
        kind: "assignment_unknown_package",
        severity: "high",
        package: row.package,
        checksum: row.checksum,
        detail: "assigned package/checksum is not in the pool; a launch resolving it fails",
      });
    }
  }

  // A specialist with no role or chain installs without complaint, then fails
  // at launch with PROFILE_UNAVAILABLE. The resolver checks declared adapter
  // support; verification health is reported separately as a warning.
  // The roster comes from the env we were handed, like everything else here.
  // Reading the caller's real environment instead mixed the specialists of one
  // home with the roster of another, and made the answer depend on the host.
  //
  // requireRoster is deliberately not used: it exits the process when the
  // roster is missing or invalid, which is right for the CLI and fatal for a
  // library caller — a diagnosis of a broken home would kill its caller.
  let roster = null;
  try {
    const candidate = loadJson(configPath(env));
    // An invalid roster is not something to resolve against. Reporting it is
    // `team-up roster validate`'s job, not this check's.
    if (candidate && validateRoster(candidate).errors.length === 0) {
      roster = candidate;
    }
  } catch {
    // No readable roster: nothing to resolve against, so skip the check
    // rather than report every specialist as broken.
  }
  if (roster) {
    const harnessCaps = (cli) =>
      defaultHarnessCapabilities(cli, execFileSync ? { env, execFileSync } : { env });
    for (const id of ids) {
      let manifest;
      try {
        manifest = loadInstalledManifest(id, { env })?.manifest;
      } catch {
        continue;
      }
      if (!manifest) continue;
      // The same requirements the launcher derives. Without them the resolver
      // is answering an easier question than the launch asks.
      const resolved = resolveProfile({
        roster,
        specialistId: id,
        requirements: {
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
          ...((manifest.permissions?.commands ?? []).length
            ? { command_broker: COMMAND_BROKER_CAPABILITY }
            : {}),
        },
        harnessCapabilities: harnessCaps,
      });
      if (resolved.code === "PROFILE_UNAVAILABLE") {
        findings.push({
          kind: "no_model_for_profile",
          severity: "high",
          id,
          profile: resolved.profile,
          skipped: (resolved.skipped ?? []).slice(0, 6),
          detail: resolved.profile
            ? "no cell of its chain is reachable; every launch fails with PROFILE_UNAVAILABLE"
            : "no role or chain assigned; every launch fails with PROFILE_UNAVAILABLE",
        });
      }
    }
  }

  // Verification is health evidence only. It never changes adapter grants or
  // specialist eligibility; missing, failed, and drifted records are warnings.
  for (const cli of listHarnessAdapters()) {
    const status = harnessStatus(cli, execFileSync ? { env, execFileSync } : { env });
    if (!["no_record", "failed", "drifted"].includes(status.status)) continue;
    const reasonText = (label, value) => value?.code
      ? `${label}: ${value.code}${value.detail ? ` (${value.detail})` : ""}`
      : null;
    const reasons = [
      reasonText("context_isolation", status.context_isolation_reason),
      reasonText("command_broker", status.command_broker_reason),
    ].filter(Boolean);
    findings.push({
      kind: status.status === "drifted" ? "harness_version_drift" : `harness_verification_${status.status === "no_record" ? "missing" : "failed"}`,
      severity: "warning",
      cli,
      installed: status.installed_version,
      status: status.status,
      ...(status.record_status ? { record_status: status.record_status } : {}),
      ...(status.context_isolation_reason?.code
        ? { context_isolation_reason: status.context_isolation_reason.code }
        : {}),
      ...(status.command_broker_reason?.code
        ? { command_broker_reason: status.command_broker_reason.code }
        : {}),
      detail: `${cli} ${status.installed_version} harness verification ${status.status}`
        + (status.record_status ? ` (${status.record_status})` : "")
        + (reasons.length ? ` — ${reasons.join("; ")}` : "")
        + "; specialist launches continue using the declared adapter capabilities",
      fix: `team-up harness verify ${cli}`,
    });
  }

  // A model a role chain names can be retired or renamed at the CLI without
  // anything in the roster changing, and pick cannot see it — the cell
  // resolves and only the spawned worker finds out. Ask the CLIs that can
  // answer. Anything else stays silent: a CLI that cannot enumerate its
  // models must not read as a missing model.
  const rosterCfg = loadJson(configPath(env));
  if (rosterCfg && execFileSync) {
    const run = (bin, args) =>
      execFileSync(bin, args, {
        encoding: "utf8",
        timeout: LIST_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
    for (const cell of checkModelAvailability({ roster: rosterCfg, run })) {
      if (cell.status !== "missing") continue;
      findings.push({
        kind: "model_unavailable",
        severity: "high",
        cli: cell.cli,
        model: cell.model,
        sent: cell.sent,
        role: cell.role,
        detail:
          `role "${cell.role}" pins ${cell.cli}:${cell.model}, but ${cell.cli} ` +
          `does not list "${cell.sent}" — dispatch fails at spawn`,
        fix: `drop the chain entry, or set models.${cell.model}.cli_model to the id ${cell.cli} uses`,
      });
    }
  }

  // Resuming everything at once after a restart team-up probably caused
  // rebuilds the same load; the human should hear it here, not in a log file.
  for (const report of listRestartReports({ logDir: debugLogDir(env) })) {
    if (report.verdict !== "team_up_suspected") continue;
    findings.push({
      kind: "restart_team_up_suspected",
      severity: "high",
      path: report.path,
      detail:
        `restart at ${report.created_at} looks caused by team-up: ` +
        `${(report.reasons ?? []).join("; ")}`,
      fix: "run fewer workers at once; team-up telemetry stats shows their footprint",
    });
  }

  // Telemetry is on, but the kernel log that would say why the machine went
  // down does not survive the restart it is meant to explain.
  if (fs.existsSync(telemetryDir(env))) {
    const store = journalStore();
    if (store?.persistent === false) {
      findings.push({
        kind: "journal_not_persistent",
        severity: "medium",
        path: "/var/log/journal",
        detail: `journald keeps logs in memory only (${store.reason}); restart reports cannot see OOM kills or how the last boot ended`,
        fix: "sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald (or set Storage=persistent in /etc/systemd/journald.conf)",
      });
    }
  }

  let admission = null;
  try {
    admission = admissionConfig(env);
  } catch (e) {
    findings.push({ kind: "admission_config_invalid", severity: "high", path: "roster.json", detail: e.message });
  }

  // Without admission.max_workers the worker limit comes from telemetry, and
  // with too little of it every dispatch is capped at fallback_max_workers —
  // which nothing said until a dispatch was refused. Only a roster dispatches.
  if (admission && rosterCfg) {
    const limits = deriveLimits({
      footprint: workerFootprint({ dir: telemetryDir(env) }),
      memTotalKb: os.totalmem() / 1024,
      config: admission,
    });
    if (limits.source === "fallback") {
      // A worker size without a limit means the samples are there but none
      // was idle: more telemetry will not help while workers never stop.
      const noBaseline = Boolean(limits.p95_rss_kb);
      findings.push({
        kind: "admission_fallback_limit",
        severity: "medium",
        path: "roster.json",
        detail: `every dispatch is capped at ${limits.max_workers} concurrent workers: no admission.max_workers, and ${noBaseline
          ? "telemetry has no idle baseline (a worker ran in every sample)"
          : "too little telemetry to derive a limit"}`,
        fix: noBaseline
          ? "set admission.max_workers in roster.json; telemetry cannot derive a limit while a worker runs in every sample"
          : FALLBACK_REMEDY,
      });
    }
  }

  const count = (s) => findings.filter((f) => f.severity === s).length;
  return {
    ok: findings.length === 0,
    checked: {
      specialists: ids.size,
      assignments: assignments.length,
    },
    counts: { high: count("high"), medium: count("medium"), low: count("low"), warning: count("warning") },
    findings,
  };
}
