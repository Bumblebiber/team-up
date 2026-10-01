import fs from "node:fs";
import path from "node:path";
import { execFileSync as realExecFileSync } from "node:child_process";
import { teamUpHome } from "../paths.mjs";
import { loadVerificationRecord } from "./verify.mjs";

/**
 * The last build that passed, kept runnable.
 *
 * Verification is keyed by CLI version, and claude updates itself daily. A
 * build the canary cannot clear yet — 2.1.286 grew a built-in plugin — used to
 * revoke every specialist on the host until someone shipped a fix. The build
 * before it was still on disk and still verified; nothing used it.
 *
 * So every verify that passes pins the exact binary it measured, and a launch
 * whose installed build is not verified runs the newest pinned one instead.
 * Pins are hardlinks, so they outlive the CLI's own updater pruning its
 * versions directory — which also means each one keeps a full binary (~240 MB
 * for claude) alive. Only the newest PINS_KEPT survive; more than one, because
 * a supervisor resume needs the exact build its descriptor recorded.
 */

export const PINS_KEPT = 3;

export function pinnedBinaryPath(cli, version, env = process.env) {
  return path.join(teamUpHome(env), "harness-bin", cli, version);
}

function binaryVersion(bin, execFileSync) {
  const out = String(execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 })).trim();
  const m = out.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)\b/);
  return m ? m[1] : out.split(/\s+/)[0] || out;
}

/** Pin the binary `cli` resolves to, if it is the build that was just verified. */
export function pinVerifiedBinary(cli, version, {
  env = process.env,
  execFileSync = realExecFileSync,
} = {}) {
  const dest = pinnedBinaryPath(cli, version, env);
  if (fs.existsSync(dest)) return dest;
  const src = fs.realpathSync(String(execFileSync("which", [cli], { encoding: "utf8" })).trim());
  // A self-update between the verify run and here would pin the wrong build.
  if (binaryVersion(src, execFileSync) !== version) return null;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.linkSync(src, dest);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
  }
  const dir = path.dirname(dest);
  for (const stale of fs.readdirSync(dir).sort(compareVersions).reverse().slice(PINS_KEPT)) {
    fs.rmSync(path.join(dir, stale), { force: true });
  }
  return dest;
}

function compareVersions(a, b) {
  const pa = a.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * The pinned build of exactly `version`, if its record is verified and the
 * binary still says it is that build. The file name is never trusted alone.
 */
export function pinnedVerifiedBinary(cli, version, {
  env = process.env,
  execFileSync = realExecFileSync,
} = {}) {
  let record;
  try {
    record = loadVerificationRecord(cli, version, env);
  } catch {
    return null;
  }
  if (record?.status !== "verified" || record.cli_version !== version) return null;
  const bin = pinnedBinaryPath(cli, version, env);
  try {
    if (binaryVersion(bin, execFileSync) !== version) return null;
  } catch {
    return null;
  }
  return { path: bin, version };
}

/** The newest pinned build that passes `pinnedVerifiedBinary`. */
export function verifiedFallbackBinary(cli, {
  env = process.env,
  execFileSync = realExecFileSync,
} = {}) {
  let names;
  try {
    names = fs.readdirSync(path.join(teamUpHome(env), "harness-bin", cli));
  } catch {
    return null;
  }
  for (const version of names.sort(compareVersions).reverse()) {
    const pinned = pinnedVerifiedBinary(cli, version, { env, execFileSync });
    if (pinned) return pinned;
  }
  return null;
}
