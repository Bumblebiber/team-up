import { ALL_TARGET } from "./assignments.mjs";

/**
 * Pure effective-set resolution. No filesystem access: callers pass the
 * assignment rows and the installed pool records.
 *
 *   intrinsic specialist package
 * + assignments targeted to all or S
 * - assignments explicitly excluding S
 *
 * Conflicting versions of one capability id are a human decision and fail
 * rather than picking a newest version implicitly.
 */
export function resolveCapabilities({ specialistId, assignments = [], installed = [] }) {
  const byKey = new Map(
    installed.map((item) => [`${item.package}:${item.checksum}`, item])
  );
  const selected = [];
  const exclusions = [];

  for (const row of assignments) {
    const targets = row.targets ?? [];
    const exclude = row.exclude ?? [];
    const targeted = targets.includes(ALL_TARGET) || targets.includes(specialistId);
    if (!targeted) continue;
    if (exclude.includes(specialistId)) {
      exclusions.push({ package: row.package, reason: `exclude:${specialistId}` });
      continue;
    }
    const found = byKey.get(`${row.package}:${row.checksum}`);
    if (!found) {
      throw new Error(`CAPABILITY_MISSING: ${row.package} ${row.checksum}`);
    }
    selected.push({
      ...found,
      reason: targets.includes(ALL_TARGET)
        ? `target:${ALL_TARGET}`
        : `target:${specialistId}`,
    });
  }

  const versions = new Map();
  for (const item of selected) {
    const prior = versions.get(item.id);
    if (!prior) {
      versions.set(item.id, item);
      continue;
    }
    if (prior.version !== item.version || prior.checksum !== item.checksum) {
      throw new Error(
        `CAPABILITY_VERSION_CONFLICT: ${prior.package} (${prior.checksum}), ${item.package} (${item.checksum})`
      );
    }
    // Identical checksum selected twice — collapse, keeping the first reason.
  }

  return {
    packages: [...versions.values()].sort((a, b) => a.id.localeCompare(b.id)),
    exclusions,
  };
}
