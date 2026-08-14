import fs from "node:fs";
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

function value(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function usage(io) {
  io.err(
    "usage: team-up capability <install|inspect|list|recommendations|enable|disable|update|rollback|remove>"
  );
  io.err("  install <source-path | git-url --git-ref <branch|tag|commit>>");
  io.err("  inspect <source-path | id@version [--checksum sha256:…]>");
  io.err("  list");
  io.err("  recommendations <specialist-id> [--project <path>]");
  io.err("  enable  <id@version> --checksum <sha256:…> --for <all|specialist-id>");
  io.err("  disable <id@version> --checksum <sha256:…> --for <all|specialist-id>");
  io.err("  update  <id@version> --from-checksum <sha256:…> [--source <path|url>] [--git-ref <ref>]");
  io.err("  rollback <id@version> --from-checksum <sha256:…> --to <id@version> --checksum <sha256:…>");
  io.err("  remove  <id@version> --checksum <sha256:…>");
  return 1;
}

/**
 * Deterministic, noninteractive capability surface. Every mutation needs an
 * explicit selector, checksum, and target — the operator skill supplies them
 * after a human choice, never this layer.
 */
export async function runCapabilityCli(args, io, { env = process.env } = {}) {
  try {
    return await dispatch(args, io, env);
  } catch (error) {
    io.err(String(error?.message || error));
    return 1;
  }
}

async function dispatch(args, io, env) {
  const [sub, subject, ...rest] = args;

  if (sub === "install") {
    if (!subject) return usage(io);
    const ref = value(rest, "--git-ref");
    const record = ref
      ? importGitCapability({ url: subject, ref }, { env })
      : importLocalCapability(subject, { env });
    io.out(JSON.stringify(record, null, 2));
    return 0;
  }

  if (sub === "inspect") {
    if (!subject) return usage(io);
    const inspected = fs.existsSync(subject)
      ? inspectCapabilitySource(subject)
      : inspectInstalledCapability(subject, {
          checksum: value(rest, "--checksum"),
          env,
        });
    io.out(JSON.stringify(inspected, null, 2));
    return 0;
  }

  if (sub === "recommendations") {
    if (!subject) return usage(io);
    const installed = loadInstalledManifest(subject, {
      project: value(rest, "--project"),
      env,
    });
    if (!installed) {
      io.err(`specialist not installed: ${subject}`);
      return 1;
    }
    // Read-only: printing recommendations never installs or enables anything.
    io.out(
      JSON.stringify(
        {
          specialist: subject,
          recommendations: normalizeRecommendations(
            installed.manifest.recommendations ?? []
          ),
        },
        null,
        2
      )
    );
    return 0;
  }

  if (sub === "list") {
    io.out(
      JSON.stringify(
        {
          packages: listInstalledCapabilities({ env }),
          assignments: loadAssignments({ env }).assignments,
        },
        null,
        2
      )
    );
    return 0;
  }

  if (sub === "update") {
    const source = value(rest, "--source") || subject;
    const ref = value(rest, "--git-ref");
    const currentChecksum = value(rest, "--from-checksum");
    if (!subject || !source || !currentChecksum) return usage(io);
    const candidate = ref
      ? importGitCapability({ url: source, ref }, { env })
      : importLocalCapability(source, { env });
    // Installs beside the old version and prints a plan that activates nothing.
    const plan = planCapabilityUpdate({
      current: { package: subject, checksum: currentChecksum },
      candidate: { package: candidate.package, checksum: candidate.checksum },
      assignments: loadAssignments({ env }).assignments,
    });
    io.out(JSON.stringify({ installed: candidate, plan }, null, 2));
    return 0;
  }

  if (sub === "rollback") {
    const toChecksum = value(rest, "--checksum");
    const fromChecksum = value(rest, "--from-checksum");
    const toPackage = value(rest, "--to") || subject;
    if (!subject || !toChecksum || !fromChecksum) return usage(io);
    const prior = inspectInstalledCapability(toPackage, {
      checksum: toChecksum,
      env,
    });
    const result = rollbackCapability({
      current: { package: subject, checksum: fromChecksum },
      prior: { package: prior.package, checksum: prior.checksum },
      assignments: loadAssignments({ env }).assignments,
      env,
    });
    io.out(JSON.stringify(result, null, 2));
    return 0;
  }

  if (sub === "remove") {
    const checksum = value(rest, "--checksum");
    if (!subject || !checksum) return usage(io);
    const target = inspectInstalledCapability(subject, { checksum, env });
    io.out(JSON.stringify(removeCapability(target, { env }), null, 2));
    return 0;
  }

  if (sub === "enable" || sub === "disable") {
    const target = value(rest, "--for");
    const checksum = value(rest, "--checksum");
    if (!subject || !target || !checksum) return usage(io);
    const mutateFn = sub === "enable" ? enableCapability : disableCapability;
    io.out(
      JSON.stringify(mutateFn({ package: subject, checksum, target, env }), null, 2)
    );
    return 0;
  }

  return usage(io);
}
