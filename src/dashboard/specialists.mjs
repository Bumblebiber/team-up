import { listInstalled, loadInstalledManifest } from "../specialists/store.mjs";
import { listApprovals } from "../specialists/approvals.mjs";
import { loadAssignments } from "../capabilities/assignments.mjs";
import { listInstalledCapabilities } from "../capabilities/store.mjs";
import { resolveCapabilities } from "../capabilities/resolve.mjs";

const short = (checksum) => String(checksum || "").replace(/^sha256:/, "").slice(0, 12);

function bundled(manifest) {
  const caps = manifest?.capabilities || {};
  return {
    skills: caps.skills || [],
    tools: caps.tools || [],
    mcps: caps.mcps || [],
    frameworks: caps.frameworks || [],
  };
}

/**
 * What one specialist actually holds: what its own package bundles, plus the
 * capability packages assigned to it. The assigned half goes through the same
 * resolveCapabilities() the launcher uses — reimplementing "all minus exclude"
 * here would let the dashboard drift from what a run really materialises.
 */
function describe(id, { env, assignments, installedCaps, approvals, versions }) {
  const loaded = loadInstalledManifest(id, { env });
  if (!loaded) return { id, error: "not installed" };
  const manifest = loaded.manifest || {};

  let assigned = [];
  let exclusions = [];
  let error = null;
  try {
    const resolved = resolveCapabilities({
      specialistId: id,
      assignments,
      installed: installedCaps,
    });
    assigned = resolved.packages.map((pkg) => ({
      package: pkg.package,
      id: pkg.id,
      version: pkg.version,
      display_name: pkg.display_name || pkg.id,
      checksum: short(pkg.checksum),
      reason: pkg.reason,
      provides: pkg.provides || {},
    }));
    exclusions = resolved.exclusions;
  } catch (err) {
    // A missing pool entry or a version conflict breaks the launch too, so the
    // widget is the right place to see it rather than a run that dies later.
    error = err.message;
  }

  return {
    id,
    display_name: manifest.display_name || id,
    version: loaded.version,
    checksum: short(loaded.checksum),
    installed_at: loaded.installed_at || null,
    versions_installed: versions,
    remit: manifest.remit || [],
    anti_remit: manifest.anti_remit || [],
    call_types: manifest.call_types || [],
    bundled: bundled(manifest),
    permissions: manifest.permissions || {},
    budget: manifest.budget || {},
    assigned,
    exclusions,
    // Approvals are per project and bound to a checksum; only the ones that
    // match the version now selected say anything about a run started today.
    approved_for: approvals
      .filter((row) => row.id === id && row.checksum === loaded.checksum)
      .map((row) => row.project)
      .sort(),
    error,
  };
}

export function buildSpecialistsView({ env = process.env } = {}) {
  const index = listInstalled(env) || {};
  const assignments = loadAssignments({ env }).assignments ?? [];
  const installedCaps = listInstalledCapabilities({ env });
  const approvals = Object.values(listApprovals(env)?.approvals ?? {});
  const specialists = Object.keys(index.specialists ?? {})
    .sort()
    .map((id) =>
      describe(id, {
        env,
        assignments,
        installedCaps,
        approvals,
        versions: (index.versions?.[id] || []).length,
      }),
    );
  return { specialists };
}
