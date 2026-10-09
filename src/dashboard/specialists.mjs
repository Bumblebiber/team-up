import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listInstalled, loadInstalledManifest, installPackage } from "../specialists/store.mjs";
import { assertSafeRelPath, assertPathInsideRoot } from "../specialists/safe-id.mjs";
import { loadAssignments } from "../capabilities/assignments.mjs";
import { listInstalledCapabilities } from "../capabilities/store.mjs";
import { resolveCapabilities } from "../capabilities/resolve.mjs";

const execFileAsync = promisify(execFile);

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
function describe(id, { env, assignments, installedCaps, versions }) {
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
      // The full checksum is what an assignment is keyed by, so removing one
      // from the panel needs it verbatim.
      checksum_full: pkg.checksum,
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
    versions: versions.map((v) => ({
      version: v.version,
      checksum: v.checksum,
      selected: v.checksum === loaded.checksum,
    })),
    remit: manifest.remit || [],
    anti_remit: manifest.anti_remit || [],
    call_types: manifest.call_types || [],
    bundled: bundled(manifest),
    permissions: manifest.permissions || {},
    budget: manifest.budget || {},
    assigned,
    exclusions,
    error,
  };
}

export function buildSpecialistsView({ env = process.env } = {}) {
  const index = listInstalled(env) || {};
  const assignments = loadAssignments({ env }).assignments ?? [];
  const installedCaps = listInstalledCapabilities({ env });
  const specialists = Object.keys(index.specialists ?? {})
    .sort()
    .map((id) =>
      describe(id, {
        env,
        assignments,
        installedCaps,
        versions: index.versions?.[id] || [],
      }),
    );
  return { specialists };
}

/**
 * The pool, for the assign dropdown: every imported capability package, with
 * what it would grant and which specialists already hold it.
 */
export function buildCapabilityPoolView({ env = process.env } = {}) {
  const assignments = loadAssignments({ env }).assignments ?? [];
  const packages = listInstalledCapabilities({ env }).map((pkg) => {
    const row = assignments.find(
      (a) => a.package === pkg.package && a.checksum === pkg.checksum,
    );
    return {
      package: pkg.package,
      id: pkg.id,
      version: pkg.version,
      display_name: pkg.display_name || pkg.id,
      checksum: pkg.checksum,
      checksum_short: short(pkg.checksum),
      provides: pkg.provides || {},
      targets: row?.targets ?? [],
      exclude: row?.exclude ?? [],
    };
  });
  return { packages: packages.sort((a, b) => a.package.localeCompare(b.package)) };
}

/**
 * A dashboard-supplied repository is a trust boundary: it becomes an argv
 * entry for git. Anything but an https GitHub URL is refused, so a leading
 * dash cannot turn into an option and no ssh:// or file:// transport can run
 * a helper. The optional #ref is checked the same way.
 */
export function parseGithubSource(input) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "repository required" };
  let url;
  try {
    url = new URL(raw.split("#")[0]);
  } catch {
    return { ok: false, error: "not a URL — expected https://github.com/owner/repo" };
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    return { ok: false, error: "only https://github.com/… is allowed" };
  }
  const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) {
    return { ok: false, error: "expected https://github.com/owner/repo" };
  }
  const [owner, repo] = parts;
  const safe = /^[A-Za-z0-9._-]+$/;
  if (!safe.test(owner) || !safe.test(repo) || owner.startsWith("-") || repo.startsWith("-")) {
    return { ok: false, error: "owner and repo may only contain [A-Za-z0-9._-]" };
  }
  const ref = raw.includes("#") ? raw.split("#").slice(1).join("#") : null;
  if (ref !== null && (!safe.test(ref) || ref.startsWith("-"))) {
    return { ok: false, error: "ref may only contain [A-Za-z0-9._-]" };
  }
  return {
    ok: true,
    owner,
    repo,
    ref,
    url: `https://github.com/${owner}/${repo}.git`,
    label: `${owner}/${repo}${ref ? `#${ref}` : ""}`,
  };
}

/**
 * Clone a specialist bundle and install it from the checkout. The package may
 * sit at the repository root or in a subdirectory named in `subdir`, which is
 * resolved and then checked to be inside the clone — a "../" would otherwise
 * install from anywhere on disk.
 */
export async function installSpecialistFromGithub(source, {
  subdir = "",
  env = process.env,
  exec = execFileAsync,
  install = installPackage,
  tmpRoot = os.tmpdir(),
} = {}) {
  const parsed = parseGithubSource(source);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };

  const checkout = fs.mkdtempSync(path.join(tmpRoot, "tu-gh-"));
  try {
    const args = ["clone", "--depth", "1"];
    if (parsed.ref) args.push("--branch", parsed.ref);
    // "--" keeps the URL an operand even if a later edit loosens the parser.
    args.push("--", parsed.url, checkout);
    // A private repo would otherwise stop and ask for credentials, hanging the
    // request until the timeout instead of saying it cannot read the repo.
    await exec("git", args, {
      timeout: 120_000,
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
    });

    let packageDir = checkout;
    if (subdir) {
      assertSafeRelPath(subdir, "subdir");
      packageDir = path.resolve(checkout, subdir);
      assertPathInsideRoot(packageDir, checkout);
    }
    const result = await install(packageDir, env);
    return { ...result, source: parsed.label };
  } catch (err) {
    return { ok: false, errors: [String(err.message || err)], source: parsed.label };
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
}
