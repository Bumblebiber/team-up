import { atomicWriteJson, loadJson } from "../json-store.mjs";
import { capabilityAssignmentsPath } from "../paths.mjs";

export const ALL_TARGET = "all";

export function loadAssignments({ env = process.env } = {}) {
  const doc = loadJson(capabilityAssignmentsPath(env)) ?? {
    schema_version: 1,
    assignments: [],
  };
  // Tolerate hand-edited documents missing optional arrays.
  doc.assignments = (doc.assignments ?? []).map((row) => ({
    ...row,
    targets: row.targets ?? [],
    exclude: row.exclude ?? [],
  }));
  return doc;
}

/**
 * Read → update one row → validate → atomic replace. The prior document
 * survives any validation failure because nothing is written until the end.
 */
function mutate({ package: pkg, checksum, target, env = process.env }, update) {
  if (!pkg?.includes("@") || !checksum?.startsWith("sha256:") || !target) {
    throw new Error("package, sha256 checksum, and target are required");
  }
  const doc = loadAssignments({ env });
  let row = doc.assignments.find(
    (item) => item.package === pkg && item.checksum === checksum
  );
  if (!row) {
    row = { package: pkg, checksum, targets: [], exclude: [] };
    doc.assignments.push(row);
  }
  update(row, target);
  row.targets = [...new Set(row.targets)].sort();
  row.exclude = [...new Set(row.exclude)].sort();
  doc.assignments = doc.assignments
    .filter((item) => item.targets.length > 0)
    .sort((a, b) =>
      `${a.package}:${a.checksum}`.localeCompare(`${b.package}:${b.checksum}`)
    );
  atomicWriteJson(capabilityAssignmentsPath(env), doc);
  return doc;
}

export function enableCapability(args) {
  return mutate(args, (row, target) => {
    if (target === ALL_TARGET) row.targets.push(ALL_TARGET);
    else if (!row.targets.includes(ALL_TARGET)) row.targets.push(target);
    row.exclude = row.exclude.filter((id) => id !== target);
  });
}

export function disableCapability(args) {
  return mutate(args, (row, target) => {
    if (target === ALL_TARGET) {
      row.targets = row.targets.filter((id) => id !== ALL_TARGET);
    } else if (row.targets.includes(ALL_TARGET)) {
      // Under `all` the only way to opt one specialist out is an exclusion.
      row.exclude.push(target);
    } else {
      row.targets = row.targets.filter((id) => id !== target);
    }
  });
}
