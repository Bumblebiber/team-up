import { checkAdmission, currentCap, resetCap } from "./admission.mjs";
import { formatQueueStatus, readQueueStatus, resumeQueuePath } from "./scheduler.mjs";

const USAGE = "usage: team-up admission <check [--cli <cli>] [--json]|reset|queue>";

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

const mb = (kb) => (kb == null ? "-" : `${Math.round(kb / 1024)} MB`);

export async function runAdmissionCli(args, io, { env = process.env, check = checkAdmission } = {}) {
  const [sub, ...rest] = args;
  if (sub === "check") {
    const decision = await check({ cli: argValue(rest, "--cli") ?? null, env });
    if (rest.includes("--json")) io.out(JSON.stringify(decision, null, 2));
    else {
      const { limits } = decision;
      io.out(decision.ok ? "admitted" : `refused: ${decision.reason}`);
      io.out(`max workers: ${limits.max_workers} (${limits.source}: ${limits.reason})`);
      io.out(`worker size p95: ${mb(limits.p95_rss_kb)}${limits.footprint_source ? ` (${limits.footprint_source})` : ""}`);
      io.out(`reserve: ${mb(limits.reserve_kb)}, headroom after start: ${mb(decision.headroom?.mem_kb)}`);
      for (const note of decision.notes ?? []) io.out(`note: ${note}`);
    }
    // Same code `specialist run` uses for a refusal.
    return decision.ok ? 0 : 3;
  }
  if (sub === "reset") {
    const cap = currentCap({ env });
    const had = resetCap({ env });
    io.out(had && cap ? `lifted the cap of ${cap.max_workers} worker(s) set after a ${cap.verdict} restart` : "no cap in force");
    return 0;
  }
  if (sub === "queue") {
    for (const line of formatQueueStatus(readQueueStatus(resumeQueuePath(env)))) io.out(line);
    return 0;
  }
  io.err(USAGE);
  return 1;
}
