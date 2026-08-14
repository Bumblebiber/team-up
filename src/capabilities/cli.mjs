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

function value(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function usage(io) {
  io.err("usage: team-up capability <install|inspect|list|enable|disable>");
  io.err("  install <source-path | git-url --git-ref <branch|tag|commit>>");
  io.err("  inspect <source-path | id@version [--checksum sha256:…]>");
  io.err("  list");
  io.err("  enable  <id@version> --checksum <sha256:…> --for <all|specialist-id>");
  io.err("  disable <id@version> --checksum <sha256:…> --for <all|specialist-id>");
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
