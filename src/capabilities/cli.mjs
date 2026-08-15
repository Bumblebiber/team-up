import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  importLocalCapability,
  inspectCapabilitySource,
  inspectInstalledCapability,
  listInstalledCapabilities,
} from "./store.mjs";
import {
  enableCapability,
  disableCapability,
  loadAssignments,
} from "./assignments.mjs";
import { importGitCapability } from "./git-source.mjs";
import { normalizeRecommendations } from "./recommendations.mjs";
import { loadInstalledManifest } from "../specialists/store.mjs";
import {
  planCapabilityUpdate,
  rollbackCapability,
  removeCapability,
} from "./lifecycle.mjs";
import { scanCapabilityRoots, normalizeDetectedCandidate } from "./scan.mjs";
import { atomicWriteJson, loadJson } from "../json-store.mjs";
import {
  capabilityAssignmentsPath,
  capabilityPoolRoot,
  runsPath,
} from "../paths.mjs";

function value(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function values(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) out.push(args[++i]);
  }
  return out;
}

function resolveInstalledSelector(subject, { checksum, env } = {}) {
  if (subject.includes("@")) {
    return inspectInstalledCapability(subject, { checksum, env });
  }
  const matches = listInstalledCapabilities({ env }).filter((item) =>
    item.id === subject && (!checksum || item.checksum === checksum));
  if (matches.length !== 1) {
    throw new Error(`capability selector must resolve exactly once: ${subject}`);
  }
  return matches[0];
}

function activeRunsWithCapabilities(env) {
  const root = runsPath(env);
  if (!fs.existsSync(root)) return [];
  const runs = [];
  for (const name of fs.readdirSync(root)) {
    const effectivePath = path.join(root, name, "EFFECTIVE_CAPABILITIES.json");
    if (!fs.existsSync(effectivePath)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(effectivePath, "utf8"));
      runs.push({
        runId: name,
        capabilities: (doc.packages ?? []).map((item) => ({
          package: item.package,
          checksum: item.checksum,
        })),
      });
    } catch {
      // ignore malformed historical records
    }
  }
  return runs;
}

function defaultScanRoots() {
  const home = os.homedir();
  return [
    path.join(home, ".claude"),
    path.join(home, ".codex"),
    path.join(home, ".agents"),
  ].filter((root) => fs.existsSync(root));
}

export async function runCapabilityCli(args, io, { env = process.env } = {}) {
  try {
    return await dispatch(args, io, env);
  } catch (error) {
    io.err(String(error.message || error));
    return 1;
  }
}

async function dispatch(args, io, env) {
  const [sub, subject, ...rest] = args;
  if (sub === "install") {
    if (!subject) return usage(io);
    const gitRef = value(rest, "--git-ref");
    const type = value(rest, "--type");
    let record;
    if (gitRef) {
      record = importGitCapability({ url: subject, ref: gitRef }, { env });
    } else if (type) {
      const manifestOverride = normalizeDetectedCandidate({ type, path: subject }, {
        id: value(rest, "--id"),
        version: value(rest, "--version"),
        displayName: value(rest, "--display-name"),
        selectedType: type,
      });
      record = importLocalCapability(subject, { env, manifestOverride });
    } else {
      record = importLocalCapability(subject, { env });
    }
    io.out(JSON.stringify(record, null, 2));
    return 0;
  }
  if (sub === "inspect") {
    if (!subject) return usage(io);
    const inspected = fs.existsSync(subject)
      ? inspectCapabilitySource(subject)
      : inspectInstalledCapability(subject, {
          checksum: value(rest, "--checksum"), env,
        });
    io.out(JSON.stringify(inspected, null, 2));
    return 0;
  }
  if (sub === "list") {
    io.out(JSON.stringify({
      packages: listInstalledCapabilities({ env }),
      assignments: loadAssignments({ env }).assignments,
    }, null, 2));
    return 0;
  }
  if (sub === "recommendations") {
    if (!subject) return usage(io);
    const loaded = loadInstalledManifest(subject, { env });
    if (!loaded?.manifest) {
      io.err(`specialist not installed: ${subject}`);
      return 1;
    }
    io.out(JSON.stringify(
      normalizeRecommendations(loaded.manifest.recommendations ?? []),
      null,
      2,
    ));
    return 0;
  }
  if (sub === "enable" || sub === "disable") {
    const target = value(rest, "--for");
    const checksum = value(rest, "--checksum");
    if (!subject || !target || !checksum) return usage(io);
    // Enabling an uninstalled checksum writes a row that only fails later, in
    // `resolveCapabilities`, at every specialist launch. Resolve it here so the
    // error lands on the command that typed it. Disable stays unchecked: it
    // only ever reduces reach, and must keep working on a stale row.
    if (sub === "enable") inspectInstalledCapability(subject, { checksum, env });
    const fn = sub === "enable" ? enableCapability : disableCapability;
    io.out(JSON.stringify(fn({ package: subject, checksum, target, env }), null, 2));
    return 0;
  }
  if (sub === "update") {
    if (!subject) return usage(io);
    const gitRef = value(rest, "--git-ref");
    const current = resolveInstalledSelector(subject, {
      checksum: value(rest, "--checksum"), env,
    });
    const source = value(rest, "--source") || current.source?.url || current.source?.path;
    if (!source) {
      io.err("update requires --source or an installed git/local source");
      return 1;
    }
    const candidate = gitRef
      ? importGitCapability({ url: source, ref: gitRef }, { env })
      : importLocalCapability(source, { env });
    io.out(JSON.stringify(planCapabilityUpdate({
      current,
      candidate,
      assignments: loadAssignments({ env }).assignments,
    }), null, 2));
    return 0;
  }
  if (sub === "rollback") {
    if (!subject) return usage(io);
    const toVersion = value(rest, "--to");
    const checksum = value(rest, "--checksum");
    const priorChecksum = value(rest, "--prior-checksum");
    if (!toVersion || !checksum || !priorChecksum) return usage(io);
    const id = subject.includes("@") ? subject.split("@")[0] : subject;
    const currentVersion = subject.includes("@")
      ? subject.split("@")[1]
      : value(rest, "--from");
    if (!currentVersion) return usage(io);
    const current = inspectInstalledCapability(`${id}@${currentVersion}`, {
      checksum, env,
    });
    const prior = inspectInstalledCapability(`${id}@${toVersion}`, {
      checksum: priorChecksum, env,
    });
    io.out(JSON.stringify(rollbackCapability({
      current,
      prior,
      assignments: loadAssignments({ env }).assignments,
      writeAssignments: (doc) => atomicWriteJson(capabilityAssignmentsPath(env), doc),
    }), null, 2));
    return 0;
  }
  if (sub === "remove") {
    if (!subject) return usage(io);
    const checksum = value(rest, "--checksum");
    if (!checksum) return usage(io);
    const target = inspectInstalledCapability(subject, { checksum, env });
    io.out(JSON.stringify(removeCapability(target, {
      assignments: loadAssignments({ env }).assignments,
      activeRuns: activeRunsWithCapabilities(env),
      removeFiles: (item) => {
        const digest = item.checksum.slice("sha256:".length);
        const dest = path.join(capabilityPoolRoot(env), item.id, item.version, digest);
        fs.rmSync(dest, { recursive: true, force: true });
        const indexPath = path.join(capabilityPoolRoot(env), "index.json");
        const index = loadJson(indexPath) ?? { schema_version: 1, packages: [] };
        index.packages = index.packages.filter((row) =>
          !(row.package === item.package && row.checksum === item.checksum));
        atomicWriteJson(indexPath, index);
      },
    }), null, 2));
    return 0;
  }
  if (sub === "scan") {
    const roots = values(rest, "--root");
    io.out(JSON.stringify(
      scanCapabilityRoots(roots.length ? roots : defaultScanRoots()),
      null,
      2,
    ));
    return 0;
  }
  return usage(io);
}

function usage(io) {
  io.err("usage: team-up capability <install|inspect|list|enable|disable|recommendations|update|rollback|remove|scan>");
  return 1;
}
