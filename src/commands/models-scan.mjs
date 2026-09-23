// models-scan.mjs — `team-up models scan` report + optional models.json persistence.

import { scanModels, defaultRun } from "../collectors/cli-models.mjs";
import { withModelPtyLock } from "../collectors/models-pty.mjs";
import {
  loadModelsStore,
  mergeModelsStore,
  writeModelsStore,
} from "../collectors/models-store.mjs";

function formatCliReport(report) {
  const lines = [];
  lines.push(`## ${report.cli}`);
  if (!report.supported) {
    lines.push(`unsupported: ${report.reason}`);
    return lines.join("\n");
  }
  if (report.gone?.length) {
    lines.push("gone (roster names it, CLI does not):");
    for (const g of report.gone) lines.push(`  - ${g.roster_id} → sent "${g.sent}"`);
  } else {
    lines.push("gone: (none)");
  }
  if (report.known?.length) {
    lines.push(`known: ${report.known.length}`);
    for (const k of report.known.slice(0, 8)) {
      const cur = k.current ? " (current)" : "";
      lines.push(`  - ${k.cli_id} ↔ ${k.roster_id}${cur}`);
    }
    if (report.known.length > 8) lines.push(`  … +${report.known.length - 8} more`);
  }
  if (report.new?.length) {
    lines.push(`new (CLI offers, roster does not): ${report.new.length}`);
    for (const n of report.new.slice(0, 8)) {
      const cur = n.current ? " (current)" : "";
      lines.push(`  - ${n.cli_id}${cur}`);
    }
    if (report.new.length > 8) lines.push(`  … +${report.new.length - 8} more`);
  } else {
    lines.push("new: (none)");
  }
  return lines.join("\n");
}

/**
 * @param {string[]} args
 * @param {{ out: Function, err: Function }} io
 * @param {{ roster: object, run?: Function, runModelPty?: Function, env?: object }} deps
 */
export function runModelsScan(
  args,
  io,
  { roster, run = defaultRun, runModelPty = withModelPtyLock, env = process.env } = {}
) {
  const json = args.includes("--json");
  const noWrite = args.includes("--no-write");
  const cliIdx = args.indexOf("--cli");
  const cliFilter = cliIdx === -1 ? undefined : args[cliIdx + 1];
  if (cliFilter !== undefined && !cliFilter) {
    io.err("usage: team-up models scan [--cli <id>] [--json] [--no-write]");
    return 1;
  }
  if (cliFilter && !roster?.clis?.[cliFilter]) {
    io.err(`unknown cli "${cliFilter}"`);
    return 1;
  }

  const scannedAt = new Date().toISOString();
  const { reports, collectedByCli } = scanModels({ roster, cliFilter, run, runModelPty });

  if (!noWrite) {
    const merged = mergeModelsStore(loadModelsStore(env), reports, collectedByCli, scannedAt);
    writeModelsStore(merged, env);
  }

  if (json) {
    io.out(JSON.stringify({ scanned_at: scannedAt, clis: reports }, null, 0));
    return 0;
  }

  const blocks = reports.map(formatCliReport);
  io.out(blocks.join("\n\n"));
  return 0;
}
