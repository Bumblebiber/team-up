export function planCapabilityUpdate({ current, candidate, assignments }) {
  if (current.package === candidate.package &&
      current.checksum === candidate.checksum) {
    throw new Error("CAPABILITY_UPDATE_UNCHANGED");
  }
  return {
    from: current, to: candidate, activate: false,
    assignmentChanges: [],
    pinnedAssignments: assignments.filter((row) =>
      row.package === current.package && row.checksum === current.checksum),
  };
}

export function rollbackCapability({
  current, prior, assignments, writeAssignments,
}) {
  if (!prior?.checksum) throw new Error("ROLLBACK_TARGET_NOT_INSTALLED");
  const next = structuredClone(assignments);
  for (const row of next) {
    if (row.package === current.package && row.checksum === current.checksum) {
      row.package = prior.package;
      row.checksum = prior.checksum;
    }
  }
  writeAssignments({ schema_version: 1, assignments: next });
  return { from: current, to: prior };
}

export function removeCapability(target, {
  assignments, activeRuns, removeFiles = () => {},
}) {
  const assignment = assignments.find((row) =>
    row.package === target.package && row.checksum === target.checksum);
  if (assignment) throw new Error("CAPABILITY_REFERENCED: assignment");
  const run = activeRuns.find((item) => item.capabilities?.some((cap) =>
    cap.package === target.package && cap.checksum === target.checksum));
  if (run) throw new Error(`CAPABILITY_REFERENCED: active run ${run.runId}`);
  removeFiles(target);
  return { removed: target.package, checksum: target.checksum };
}
