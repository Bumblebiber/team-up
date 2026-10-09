import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync as realExecFileSync } from "node:child_process";
import { claudeAdapter } from "./claude.mjs";
import { unsupportedAdapter } from "./unsupported.mjs";
import { CONTEXT_ISOLATION_CAPABILITY, UNVERIFIED_CAPABILITIES } from "./capabilities.mjs";
import { loadVerificationRecord, listVerificationRecords } from "./verify.mjs";
import { brokerBinPath } from "../commands/mcp-server.mjs";

const ADAPTERS = Object.freeze({
  claude: claudeAdapter,
});

export function getAdapter(cli) {
  return ADAPTERS[cli] ?? unsupportedAdapter(String(cli || "unknown"));
}

export function declaredHarnessCapabilities(cli) {
  return getAdapter(cli).capabilities;
}

export function harnessCapabilities(cli) {
  // Verification remains useful health evidence. Launch requirements come
  // from the adapter's declared support, so a missing record cannot refuse it.
  return { ...(getAdapter(cli).capabilities ?? UNVERIFIED_CAPABILITIES) };
}

export function harnessStatus(
  cli,
  { env = process.env, execFileSync = realExecFileSync } = {}
) {
  const adapter = getAdapter(cli);
  if (adapter.unsupported) return { cli, status: "unsupported", installed_version: null };

  let installed = null;
  try {
    installed = adapter.version({ execFileSync });
  } catch {
    // Not installed, or refuses to say. Nothing to verify against, and that is
    // not drift.
    return { cli, status: "not_installed", installed_version: null };
  }

  let record;
  try {
    record = loadVerificationRecord(adapter.id, installed, env);
  } catch (error) {
    return { cli, installed_version: installed, status: "failed", error: error.message };
  }
  if (record?.status === "verified") return { cli, installed_version: installed, status: "verified" };
  if (record) {
    return {
      cli,
      installed_version: installed,
      status: "failed",
      record_status: record.status ?? "invalid",
      ...(record.context_isolation_reason
        ? { context_isolation_reason: record.context_isolation_reason }
        : {}),
      ...(record.command_broker_reason
        ? { command_broker_reason: record.command_broker_reason }
        : {}),
    };
  }
  const previous = listVerificationRecords(adapter.id, env).find((item) => item.status === "verified");
  return {
    cli,
    installed_version: installed,
    status: previous ? "drifted" : "no_record",
    ...(previous ? { last_verified_version: previous.version, last_checked_at: previous.checked_at } : {}),
  };
}

/** The CLI ids this build has an adapter entry for. */
export function listHarnessAdapters() {
  return Object.keys(ADAPTERS);
}

/** Every adapter this build knows about, for a host-wide health check. */
export function harnessStatusAll(opts = {}) {
  return Object.keys(ADAPTERS).map((cli) => harnessStatus(cli, opts));
}

export function defaultHarnessCapabilities(cli, opts = {}) {
  try {
    return harnessCapabilities(cli, opts);
  } catch {
    return { ...UNVERIFIED_CAPABILITIES };
  }
}

/** Turn adapter-provided environment entries into an argv prefix. */
export function injectAdapterEnv(argv, envMap) {
  const entries = Object.entries(envMap || {}).filter(([, value]) => value != null && value !== "");
  return entries.length ? ["env", ...entries.map(([key, value]) => `${key}=${value}`), ...argv] : argv;
}

/**
 * Prepare harness argv/env/files for a specialist launch.
 */
export function prepareHarnessLaunch({
  cli,
  argv,
  runDir,
  broker = null,
  capsule = null,
  allowedBuiltins,
  env = process.env,
  execFileSync = realExecFileSync,
  writeFileSync = fs.writeFileSync,
  mkdirSync = fs.mkdirSync,
  chmodSync = fs.chmodSync,
  nodePath = process.execPath,
  brokerBin = brokerBinPath(),
}) {
  const adapter = getAdapter(cli);
  const caps = harnessCapabilities(cli);
  if (broker && caps.command_broker == null) {
    const err = new Error(
      `HARNESS_UNSUPPORTED: ${cli} lacks command broker support`
    );
    err.code = "HARNESS_UNSUPPORTED";
    throw err;
  }
  if (capsule && caps.context_isolation !== CONTEXT_ISOLATION_CAPABILITY) {
    const err = new Error(
      `HARNESS_CONTEXT_ISOLATION_UNSUPPORTED: ${cli} lacks context isolation support`
    );
    err.code = "HARNESS_CONTEXT_ISOLATION_UNSUPPORTED";
    throw err;
  }
  if (!broker && !capsule) {
    return { argv, env: {}, files: [], adapter: adapter.id, capabilities: caps };
  }
  // A capsule is as much a permission boundary as a broker: it pins the tool
  // allowlist and pre-approves exactly that set. Sanitizing only for brokers
  // left every specialist without `commands` handing the roster's raw argv —
  // `--dangerously-skip-permissions` and all — to prepareLaunch, which then
  // refused the launch outright. The refusal there stays as the backstop for
  // a caller that skipped this.
  const brokeredArgv =
    (broker || capsule) && typeof adapter.sanitizeBrokeredArgv === "function"
      ? adapter.sanitizeBrokeredArgv(argv)
      : argv;
  return {
    ...adapter.prepareLaunch({
      argv: brokeredArgv,
      runDir,
      broker,
      capsule,
      allowedBuiltins,
      nodePath,
      brokerBin,
      writeFileSync,
      mkdirSync,
      chmodSync,
    }),
    adapter: adapter.id,
    capabilities: caps,
  };
}

export function packageHarnessDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)));
}
