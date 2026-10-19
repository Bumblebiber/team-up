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
import { resolveProfile, specialistAssignment } from "../roster/profile.mjs";
import { COMMAND_BROKER_CAPABILITY, CONTEXT_ISOLATION_CAPABILITY } from "../harness/capabilities.mjs";
import { modelLabel } from "./roles.mjs";
import { ageMs } from "./data.mjs";
import { cloneRoots } from "./projects.mjs";
import { real, isInside } from "../runs/clone-cleanup.mjs";

const execFileAsync = promisify(execFile);

const short = (checksum) => String(checksum || "").replace(/^sha256:/, "").slice(0, 12);

const CATEGORIES = new Set(["coding", "testing", "review", "research", "marketing"]);
const category = (id) => {
  const prefix = id.split(".")[0];
  return CATEGORIES.has(prefix) ? prefix : "other";
};

// Specialists renamed after they had runs: those runs stay their history.
const RENAMED = new Map([
  ["testing.hannes", "testing.tessa"],
  ["research.hugo", "research.reanna"],
]);

/** The newest run per specialist id, in one pass over every run. */
function latestRuns(states) {
  const latest = new Map();
  for (const state of states) {
    const raw = String(state.role ?? "").match(/^specialist:(.+)$/)?.[1];
    if (!raw) continue;
    const id = RENAMED.get(raw) ?? raw;
    // ISO timestamps from toISOString compare as strings.
    if (String(state.createdAt ?? "") > String(latest.get(id)?.createdAt ?? "")) latest.set(id, state);
  }
  return latest;
}

/**
 * `{label, name}` like an inbox item's project, or null for a run in a clone.
 * ponytail: label null and name = cwd basename, until the run→project resolver
 * (spec §1) lands; then a clone run resolves to its real project too.
 */
function runProject(cwd, roots) {
  if (!cwd) return null;
  const dir = real(cwd) ?? path.resolve(cwd);
  if (roots.some((root) => dir === root || isInside(dir, root))) return null;
  return { label: null, name: path.basename(dir) };
}

function lastRunView(state, now, roots) {
  if (!state) return null;
  return {
    runId: state.runId,
    status: state.status,
    project: runProject(state.cwd, roots),
    createdAt: state.createdAt ?? null,
    ageMs: ageMs(state.createdAt, now),
  };
}

/**
 * The model a launch would get now: the first cell of the resolution the
 * launcher runs, with the requirements it derives from the manifest (doctor.mjs
 * asks the same), labelled like a /api/roles pick. Null with the reason when
 * no cell is reachable.
 */
function currentModel(id, manifest, { roster, usage, store, now }) {
  const resolved = resolveProfile({
    roster,
    usage,
    specialistId: id,
    now,
    requirements: {
      context_isolation: CONTEXT_ISOLATION_CAPABILITY,
      ...((manifest.permissions?.commands ?? []).length ? { command_broker: COMMAND_BROKER_CAPABILITY } : {}),
    },
  });
  const cell = resolved.chain[0];
  if (cell) return { model: modelLabel(roster, store, cell.model, cell.cli), modelReason: null };
  return {
    model: null,
    modelReason: resolved.skipped.slice(0, 6).map((s) => (s.model === "*" ? s.reason : `${s.model}: ${s.reason}`)).join("; "),
  };
}

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
function describe(id, { env, assignments, installedCaps, versions, roster, usage, store, now, lastRun, roots }) {
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
    category: category(id),
    assignment: specialistAssignment(roster, id),
    ...currentModel(id, manifest, { roster, usage, store, now }),
    lastRun: lastRunView(lastRun, now, roots),
  };
}

/** A specialist's display name, or its id when it is not installed. */
export function specialistName(id, { env = process.env } = {}) {
  try {
    return loadInstalledManifest(id, { env })?.manifest?.display_name || id;
  } catch {
    // A roster key that is no safe id has no manifest either.
    return id;
  }
}

/**
 * `states` is the run list the caller already holds (runs are read once, not
 * per specialist); `roster`, `usage` and `store` feed the model label.
 */
export function buildSpecialistsView({
  env = process.env,
  roster = null,
  usage = {},
  store = null,
  states = [],
  now = Date.now(),
} = {}) {
  const index = listInstalled(env) || {};
  const assignments = loadAssignments({ env }).assignments ?? [];
  const installedCaps = listInstalledCapabilities({ env });
  const lastRuns = latestRuns(states);
  const roots = cloneRoots(env);
  const specialists = Object.keys(index.specialists ?? {})
    .sort()
    .map((id) =>
      describe(id, {
        env,
        assignments,
        installedCaps,
        versions: index.versions?.[id] || [],
        roster,
        usage,
        store,
        now,
        lastRun: lastRuns.get(id),
        roots,
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
