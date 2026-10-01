import { atomicWriteJson, loadJson } from "../json-store.mjs";
import { capabilityAssignmentsPath } from "../paths.mjs";
import { HOST_TARGET } from "./skill-scope.mjs";

export function loadAssignments({ env = process.env } = {}) {
  return loadJson(capabilityAssignmentsPath(env)) ??
    { schema_version: 1, assignments: [] };
}

/**
 * `beforeWrite` sees the document as it is about to be stored and may throw
 * to refuse it. Host links are planned there, so a collision in the host
 * skill directory leaves the assignments untouched instead of recording a
 * share that never happened.
 */
function mutate({ package: pkg, checksum, target, env, beforeWrite }, update) {
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
  if (beforeWrite) beforeWrite(doc);
  atomicWriteJson(capabilityAssignmentsPath(env), doc);
  return doc;
}

// The host is not a specialist, so `all` neither covers nor excludes it: a
// shared package is `--for all` and `--for host`, two separate decisions.
export function enableCapability(args) {
  return mutate(args, (row) => {
    if (args.target === "all" || args.target === HOST_TARGET) row.targets.push(args.target);
    else if (!row.targets.includes("all")) row.targets.push(args.target);
    row.exclude = row.exclude.filter((id) => id !== args.target);
  });
}

export function disableCapability(args) {
  return mutate(args, (row) => {
    if (args.target === "all" || args.target === HOST_TARGET) {
      row.targets = row.targets.filter((id) => id !== args.target);
    } else if (row.targets.includes("all")) row.exclude.push(args.target);
    else row.targets = row.targets.filter((id) => id !== args.target);
  });
}
