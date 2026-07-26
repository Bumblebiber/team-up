export function resolveCapabilities({ specialistId, assignments, installed }) {
  const byKey = new Map(installed.map((item) =>
    [`${item.package}:${item.checksum}`, item]));
  const selected = [];
  const exclusions = [];
  for (const row of assignments) {
    const targeted = row.targets.includes("all") ||
      row.targets.includes(specialistId);
    if (!targeted) continue;
    if (row.exclude.includes(specialistId)) {
      exclusions.push({ package: row.package, reason: `exclude:${specialistId}` });
      continue;
    }
    const found = byKey.get(`${row.package}:${row.checksum}`);
    if (!found) {
      throw new Error(`CAPABILITY_MISSING: ${row.package} ${row.checksum}`);
    }
    selected.push({
      ...found,
      reason: row.targets.includes(specialistId)
        ? `target:${specialistId}` : "target:all",
    });
  }
  const versions = new Map();
  for (const item of selected) {
    const prior = versions.get(item.id);
    if (prior && (prior.version !== item.version ||
        prior.checksum !== item.checksum)) {
      throw new Error(`CAPABILITY_VERSION_CONFLICT: ${prior.package}, ${item.package}`);
    }
    versions.set(item.id, item);
  }
  return {
    packages: [...versions.values()].sort((a, b) => a.id.localeCompare(b.id)),
    exclusions,
  };
}
