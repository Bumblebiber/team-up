import fs from "node:fs";
import path from "node:path";
import { teamUpHome, specialistApprovalsPath } from "./paths.mjs";
import { listInstalled } from "./specialists/store.mjs";
import { listInstalledCapabilities } from "./capabilities/store.mjs";
import { loadAssignments } from "./capabilities/assignments.mjs";
import { loadInstalledManifest } from "./specialists/store.mjs";
import { resolveProfile } from "./roster/profile.mjs";
import {
  COMMAND_BROKER_CAPABILITY,
  CONTEXT_ISOLATION_CAPABILITY,
} from "./harness/capabilities.mjs";
import { configPath, loadJson, validateRoster } from "./roster/config.mjs";
import { harnessStatus, listHarnessAdapters } from "./harness/registry.mjs";
import { listVerificationRecords } from "./harness/verify.mjs";

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
export function diagnose(env = process.env, { execFileSync } = {}) {
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

  // A specialist whose model profile no roster cell can satisfy installs,
  // approves and pins without complaint, then fails at launch with
  // PROFILE_UNAVAILABLE. Nothing between building it and running it says so.
  // Asking the real resolver is the only honest check: the reason is rarely the
  // tier itself — coding.codey asks for `high`, four cells offer it, and it
  // still cannot launch because the only reachable one runs on an adapter with
  // no verified context isolation on this host.
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
    for (const id of ids) {
      let manifest;
      try {
        manifest = loadInstalledManifest(id, { env })?.manifest;
      } catch {
        continue;
      }
      if (!manifest?.model_profile) continue;
      const callType = (manifest.call_types ?? [])[0];
      if (!callType) continue;
      // The same requirements the launcher derives. Without them the resolver
      // is answering an easier question than the launch asks.
      const resolved = resolveProfile({
        roster,
        profile: manifest.model_profile,
        specialistId: id,
        callType,
        requirements: {
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
          ...((manifest.permissions?.commands ?? []).length
            ? { command_broker: COMMAND_BROKER_CAPABILITY }
            : {}),
        },
      });
      if (resolved.code === "PROFILE_UNAVAILABLE") {
        findings.push({
          kind: "no_model_for_profile",
          severity: "high",
          id,
          profile: manifest.model_profile,
          call_type: callType,
          skipped: (resolved.skipped ?? []).slice(0, 6),
          detail: "no roster model satisfies this profile; every launch fails with PROFILE_UNAVAILABLE",
        });
      }
    }
  }

  const approvals = readJson(specialistApprovalsPath(env))?.approvals ?? {};
  // Approving a new version leaves the old row in place, which is normal and
  // harmless: the launcher matches on checksum, so a superseded row is simply
  // never selected. Only report a mismatch when nothing else covers that
  // specialist for that project — otherwise every upgrade produces a finding.
  const covered = new Set();
  for (const a of Object.values(approvals)) {
    if (ids.has(a.id) && installed[a.id].checksum === a.checksum) {
      covered.add(`${a.id}\u0000${a.project}`);
    }
  }
  for (const [key, a] of Object.entries(approvals)) {
    if (!ids.has(a.id)) {
      findings.push({
        kind: "approval_unknown_specialist",
        severity: "medium",
        id: a.id,
        approval: String(key).slice(0, 12),
        detail: "approval names no installed specialist",
      });
    } else if (
      a.checksum &&
      installed[a.id].checksum !== a.checksum &&
      !covered.has(`${a.id}\u0000${a.project}`)
    ) {
      findings.push({
        kind: "approval_stale_version",
        severity: "medium",
        id: a.id,
        approved: a.version,
        installed: installed[a.id].version,
        detail: "approval is bound to a checksum that is no longer the installed one",
      });
    }
    if (a.project && !fs.existsSync(a.project)) {
      findings.push({
        kind: "approval_missing_project",
        severity: "low",
        id: a.id,
        project: a.project,
        detail: "approved project directory no longer exists",
      });
    }
  }

  const pins = readJson(path.join(teamUpHome(env), "specialists-pins.json"))?.pins ?? {};
  for (const [id, pin] of Object.entries(pins)) {
    if (!ids.has(id)) {
      findings.push({
        kind: "pin_unknown_specialist",
        severity: "medium",
        id,
        detail: "pin names no installed specialist",
      });
    } else if (pin.checksum && installed[id].checksum !== pin.checksum) {
      findings.push({
        kind: "pin_stale_checksum",
        severity: "medium",
        id,
        pinned: pin.version,
        installed: installed[id].version,
        detail: "pinned checksum is not the installed one",
      });
    }
  }

  // Harness verification is keyed by CLI version, so a self-update silently
  // revokes every grant on the host. Until now that surfaced only as
  // `no_model_for_profile` — the symptom, named after the roster, and only
  // when a specialist with a model_profile happened to be installed. This
  // reports the cause directly and does not care whether anything is
  // installed.
  //
  // Only adapters that already have a record are inspected: an adapter with
  // none cannot have drifted, and skipping them keeps `diagnose` free of a
  // subprocess per CLI in the common case (a fresh home has no records).
  for (const cli of listHarnessAdapters()) {
    if (!listVerificationRecords(cli, env).length) continue;
    const status = harnessStatus(cli, execFileSync ? { env, execFileSync } : { env });
    if (status.status !== "drifted") continue;
    findings.push({
      kind: "harness_version_drift",
      severity: "high",
      cli,
      installed: status.installed_version,
      last_verified: status.last_verified_version,
      detail:
        `${cli} ${status.installed_version} has no verification record ` +
        `(${status.last_verified_version} passed on ${status.last_checked_at}); ` +
        "every capability it granted is revoked until it is re-verified",
      fix: `team-up harness verify ${cli} --fixture-project <path>`,
    });
  }

  const count = (s) => findings.filter((f) => f.severity === s).length;
  return {
    ok: findings.length === 0,
    checked: {
      specialists: ids.size,
      assignments: assignments.length,
      approvals: Object.keys(approvals).length,
      pins: Object.keys(pins).length,
    },
    counts: { high: count("high"), medium: count("medium"), low: count("low") },
    findings,
  };
}
