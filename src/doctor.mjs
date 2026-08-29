import fs from "node:fs";
import path from "node:path";
import { teamUpHome, specialistApprovalsPath } from "./paths.mjs";
import { listInstalled } from "./specialists/store.mjs";
import { listInstalledCapabilities } from "./capabilities/store.mjs";
import { loadAssignments } from "./capabilities/assignments.mjs";

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
export function diagnose(env = process.env) {
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

  const approvals = readJson(specialistApprovalsPath(env))?.approvals ?? {};
  for (const [key, a] of Object.entries(approvals)) {
    if (!ids.has(a.id)) {
      findings.push({
        kind: "approval_unknown_specialist",
        severity: "medium",
        id: a.id,
        approval: String(key).slice(0, 12),
        detail: "approval names no installed specialist",
      });
    } else if (a.checksum && installed[a.id].checksum !== a.checksum) {
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
