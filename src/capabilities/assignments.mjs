import { atomicWriteJson, loadJson } from "../json-store.mjs";
import { capabilityAssignmentsPath } from "../paths.mjs";

export function loadAssignments({ env = process.env } = {}) {
  return loadJson(capabilityAssignmentsPath(env)) ??
    { schema_version: 1, assignments: [] };
}

function mutate({ package: pkg, checksum, target, env }, update) {
  if (!pkg?.includes("@") || !checksum?.startsWith("sha256:") || !target) {
    throw new Error("package, sha256 checksum, and target are required");
  }
  const doc = loadAssignments({ env });
  let row = doc.assignments.find((item) =>
    item.package === pkg && item.checksum === checksum);
  if (!row) {
    row = { package: pkg, checksum, targets: [], exclude: [] };
    doc.assignments.push(row);
  }
  update(row);
  row.targets = [...new Set(row.targets)].sort();
  row.exclude = [...new Set(row.exclude)].sort();
  doc.assignments = doc.assignments
    .filter((item) => item.targets.length > 0)
    .sort((a, b) => `${a.package}:${a.checksum}`.localeCompare(
      `${b.package}:${b.checksum}`));
  atomicWriteJson(capabilityAssignmentsPath(env), doc);
  return doc;
}

export function enableCapability(args) {
  return mutate(args, (row) => {
    if (args.target === "all") row.targets.push("all");
    else if (!row.targets.includes("all")) row.targets.push(args.target);
    row.exclude = row.exclude.filter((id) => id !== args.target);
  });
}

export function disableCapability(args) {
  return mutate(args, (row) => {
    if (args.target === "all") row.targets = row.targets.filter((id) => id !== "all");
    else if (row.targets.includes("all")) row.exclude.push(args.target);
    else row.targets = row.targets.filter((id) => id !== args.target);
  });
}
