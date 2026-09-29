import fs from "node:fs";
import path from "node:path";
import { execFileSync as realExecFileSync } from "node:child_process";
import { harnessStatus, listHarnessAdapters } from "./registry.mjs";
import { listVerificationRecords, verificationAttemptPath } from "./verify.mjs";
import {
  HARNESS_VERIFY_CLIS,
  harnessFixtureProject,
  runHarnessVerify,
} from "./cli-verify.mjs";

/**
 * Drift repaired instead of reported.
 *
 * Verification is keyed by CLI version and claude updates itself daily, so
 * every self-update revokes every grant on the host until someone re-runs
 * `harness verify` by hand. The detector was never missing — `harnessStatus`
 * already tells `drifted` apart from `no_record` and `failed`. This is the
 * part that acts on it: the health cron re-verifies instead of alerting, and
 * a launch re-verifies once instead of refusing.
 *
 * The cost is one real CLI run against the fixture — a paid call, about a
 * minute — once per update. Two hazards make the marker in `verify.mjs`
 * necessary rather than nice:
 *
 *   - a verify that throws writes no record, so drift survives it and an
 *     unguarded retry repeats the paid run forever (logged out, over quota);
 *   - a pipeline fan-out right after an update has every writer find the same
 *     drift at the same second.
 *
 * One marker covers both: an exclusive create is the lock, its timestamp is
 * the cooldown.
 */

/** A failed attempt is not retried before this — a logged-out host must not pay per cron tick. */
export const REVERIFY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** A `running` marker older than this belonged to a process that died. */
export const REVERIFY_STALE_MS = 15 * 60 * 1000;

function readAttempt(marker) {
  try {
    return JSON.parse(fs.readFileSync(marker, "utf8"));
  } catch {
    return null;
  }
}

function writeAttempt(marker, data, flag) {
  fs.writeFileSync(marker, JSON.stringify(data), flag ? { flag } : undefined);
}

/** "claimed" — go ahead; "in_flight" — someone else is running it; "cooling" — it failed recently. */
function claimAttempt(marker, nowMs) {
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  try {
    writeAttempt(marker, { at: nowMs, state: "running" }, "wx");
    return "claimed";
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const prev = readAttempt(marker);
  const age = nowMs - (prev?.at ?? 0);
  if (prev?.state === "running") {
    if (age < REVERIFY_STALE_MS) return "in_flight";
  } else if (age < REVERIFY_COOLDOWN_MS) {
    return "cooling";
  }
  writeAttempt(marker, { at: nowMs, state: "running" });
  return "claimed";
}

/**
 * Re-verify `cli` if — and only if — the installed build has drifted away from
 * a passing record. Anything else is left alone: `no_record` was never
 * granted anything, `failed` is a known no, and a CLI without a live runner
 * cannot be verified at all.
 *
 * `wait: true` (a launch) blocks for a bounded while when another process
 * holds the attempt, so a fan-out pays for one verification and not five.
 */
export async function reverifyDrifted(cli, {
  env = process.env,
  execFileSync = realExecFileSync,
  verify = runHarnessVerify,
  io = { out: () => {}, err: () => {} },
  wait = false,
  waitMs = 180_000,
  pollMs = 5_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const status = harnessStatus(cli, { env, execFileSync });
  if (status.status !== "drifted") {
    return { cli, attempted: false, status: status.status };
  }
  if (!HARNESS_VERIFY_CLIS.has(cli)) {
    return { cli, attempted: false, status: "drifted", reason: "unsupported" };
  }
  const marker = verificationAttemptPath(cli, status.installed_version, env);
  const claim = claimAttempt(marker, now());
  if (claim !== "claimed") {
    if (claim === "in_flight" && wait) {
      const deadline = now() + waitMs;
      while (now() < deadline) {
        await sleep(pollMs);
        const s = harnessStatus(cli, { env, execFileSync });
        if (s.status !== "drifted") {
          return { cli, attempted: false, status: s.status, reason: "verified_elsewhere" };
        }
      }
    }
    return { cli, attempted: false, status: "drifted", reason: claim };
  }
  let exitCode = 2;
  try {
    exitCode = await verify([cli, "--fixture-project", harnessFixtureProject()], { ...io, env });
    return {
      cli,
      attempted: true,
      exit_code: exitCode,
      from_version: status.last_verified_version,
      status: harnessStatus(cli, { env, execFileSync }).status,
    };
  } finally {
    writeAttempt(marker, { at: now(), state: "done", exit_code: exitCode });
  }
}

/** Every adapter that has ever been verified on this host. */
export async function reverifyAllDrifted(opts = {}) {
  const env = opts.env ?? process.env;
  const out = [];
  for (const cli of listHarnessAdapters()) {
    if (!listVerificationRecords(cli, env).length) continue;
    out.push(await reverifyDrifted(cli, opts));
  }
  return out;
}

export async function runHarnessReverify(args, io = { out: console.log, err: console.error }) {
  if (args.length) {
    io.err("usage: team-up harness reverify");
    return 1;
  }
  const results = await reverifyAllDrifted({ env: io.env || process.env, io });
  let failed = 0;
  for (const r of results) {
    if (!r.attempted) {
      if (r.status === "drifted") io.out(`${r.cli}: drifted, not re-verified (${r.reason})`);
      continue;
    }
    io.out(`${r.cli}: re-verified ${r.from_version} → ${r.status}`);
    if (r.status !== "verified") failed += 1;
  }
  return failed ? 2 : 0;
}
