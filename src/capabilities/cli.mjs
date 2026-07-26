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

function value(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

export async function runCapabilityCli(args, io, { env = process.env } = {}) {
  const [sub, subject, ...rest] = args;
  if (sub === "install") {
    if (!subject) return usage(io);
    io.out(JSON.stringify(importLocalCapability(subject, { env }), null, 2));
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
  if (sub === "enable" || sub === "disable") {
    const target = value(rest, "--for");
    const checksum = value(rest, "--checksum");
    if (!subject || !target || !checksum) return usage(io);
    const fn = sub === "enable" ? enableCapability : disableCapability;
    io.out(JSON.stringify(fn({ package: subject, checksum, target, env }), null, 2));
    return 0;
  }
  return usage(io);
}

function usage(io) {
  io.err("usage: team-up capability <install|inspect|list|enable|disable>");
  return 1;
}
