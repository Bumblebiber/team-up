import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, loadJson } from "../json-store.mjs";
import { capabilityAssignmentsPath, runsPath } from "../paths.mjs";
import { capabilityIndexPath, listInstalledCapabilities } from "./store.mjs";

/** Run states that still hold their capsule contents. */
const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

/**
 * Updating installs a new immutable version beside the old one. It never
 * activates: existing assignments stay pinned until the human selects the new
 * version explicitly.
 */
export function planCapabilityUpdate({ current, candidate, assignments = [] }) {
  if (
    current.package === candidate.package &&
    current.checksum === candidate.checksum
  ) {
    throw new Error("CAPABILITY_UPDATE_UNCHANGED");
  }
  return {
    from: current,
    to: candidate,
    activate: false,
    assignmentChanges: [],
    pinnedAssignments: assignments.filter(
      (row) => row.package === current.package && row.checksum === current.checksum
    ),
  };
}

/**
 * Rollback repoints assignment selectors to a previously installed checksum.
 * It rewrites neither the package nor any historical run.
 */
export function rollbackCapability({
  current,
  prior,
  assignments,
  writeAssignments,
  env = process.env,
}) {
  if (!prior?.checksum) throw new Error("ROLLBACK_TARGET_NOT_INSTALLED");
  const write =
    writeAssignments ??
    ((doc) => atomicWriteJson(capabilityAssignmentsPath(env), doc));
  const next = structuredClone(assignments);
  for (const row of next) {
    if (row.package === current.package && row.checksum === current.checksum) {
      row.package = prior.package;
      row.checksum = prior.checksum;
    }
  }
  write({ schema_version: 1, assignments: next });
  return { from: current, to: prior };
}

/**
 * Every capability an unfinished run still depends on, read from that run's
 * own audit record.
 */
export function activeRunCapabilityReferences({ env = process.env } = {}) {
  const root = runsPath(env);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const active = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const state = loadJson(path.join(dir, "STATE.json"));
    if (!state || TERMINAL_STATUSES.has(state.status)) continue;
    const effective = loadJson(path.join(dir, "EFFECTIVE_CAPABILITIES.json"));
    if (!effective?.packages?.length) continue;
    active.push({
      runId: entry.name,
      capabilities: effective.packages.map((item) => ({
        package: item.package,
        checksum: item.checksum,
      })),
    });
  }
  return active;
}

/**
 * Remove one exact digest. Refused while any assignment or unfinished run
 * references it; sibling versions are never touched.
 */
export function removeCapability(
  target,
  { assignments, activeRuns, removeFiles, env = process.env } = {}
) {
  const rows = assignments ?? loadJson(capabilityAssignmentsPath(env))?.assignments ?? [];
  const assignment = rows.find(
    (row) => row.package === target.package && row.checksum === target.checksum
  );
  if (assignment) throw new Error("CAPABILITY_REFERENCED: assignment");

  const runs = activeRuns ?? activeRunCapabilityReferences({ env });
  const run = runs.find((item) =>
    item.capabilities?.some(
      (cap) => cap.package === target.package && cap.checksum === target.checksum
    )
  );
  if (run) throw new Error(`CAPABILITY_REFERENCED: active run ${run.runId}`);

  const drop =
    removeFiles ??
    ((item) => {
      if (!item.packageDir) return;
      // packageDir is <pool>/<id>/<version>/<digest>/package
      fs.rmSync(path.dirname(item.packageDir), { recursive: true, force: true });
    });
  drop(target);

  const indexPath = capabilityIndexPath(env);
  const installed = listInstalledCapabilities({ env });
  const remaining = installed.filter(
    (item) => !(item.package === target.package && item.checksum === target.checksum)
  );
  if (remaining.length !== installed.length) {
    atomicWriteJson(indexPath, { schema_version: 1, packages: remaining });
  }
  return { removed: target.package, checksum: target.checksum };
}
