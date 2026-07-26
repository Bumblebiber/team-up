import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync as realExecFileSync } from "node:child_process";
import { claudeAdapter } from "./claude.mjs";
import { codexAdapter } from "./codex.mjs";
import { unsupportedAdapter } from "./unsupported.mjs";
import {
  CONTEXT_ISOLATION_CAPABILITY,
  UNVERIFIED_CAPABILITIES,
} from "./capabilities.mjs";
import { loadVerificationRecord } from "./verify.mjs";
import { brokerBinPath } from "../commands/mcp-server.mjs";

const ADAPTERS = Object.freeze({
  claude: claudeAdapter,
  cursor: unsupportedAdapter("cursor"),
  codex: codexAdapter,
  hermes: unsupportedAdapter("hermes"),
  opencode: unsupportedAdapter("opencode"),
});

export function getAdapter(cli) {
  const adapter = ADAPTERS[cli];
  if (!adapter) {
    const err = new Error(`HARNESS_UNSUPPORTED: unknown harness ${cli}`);
    err.code = "HARNESS_UNSUPPORTED";
    throw err;
  }
  return adapter;
}

export function declaredHarnessCapabilities(cli) {
  return getAdapter(cli).capabilities;
}

export function harnessCapabilities(
  cli,
  { verification = undefined, env = process.env, execFileSync = realExecFileSync } = {}
) {
  const adapter = getAdapter(cli);
  let record = verification;
  if (verification === undefined) {
    try {
      const version = adapter.version({ execFileSync });
      record = loadVerificationRecord(adapter.id, version, env);
    } catch {
      record = null;
    }
  }
  if (record?.status === "verified") {
    return {
      // Legacy broker-only records may omit command_broker; keep that working.
      // context_isolation must be explicit — never inferred from status alone.
      command_broker: Object.hasOwn(record, "command_broker")
        ? record.command_broker
        : (adapter.capabilities.command_broker ?? null),
      context_isolation: Object.hasOwn(record, "context_isolation")
        ? record.context_isolation
        : null,
      native_shell: adapter.capabilities.native_shell,
      mcp: adapter.capabilities.mcp,
    };
  }
  return { ...UNVERIFIED_CAPABILITIES };
}

export function defaultHarnessCapabilities(cli, opts = {}) {
  try {
    return harnessCapabilities(cli, opts);
  } catch {
    return { ...UNVERIFIED_CAPABILITIES };
  }
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
  verification,
  env = process.env,
  execFileSync = realExecFileSync,
  writeFileSync = fs.writeFileSync,
  mkdirSync = fs.mkdirSync,
  chmodSync = fs.chmodSync,
  nodePath = process.execPath,
  brokerBin = brokerBinPath(),
}) {
  const adapter = getAdapter(cli);
  const caps = harnessCapabilities(cli, { verification, env, execFileSync });
  if (broker && caps.command_broker == null) {
    const err = new Error(
      `HARNESS_UNSUPPORTED: ${cli} lacks verified command broker`
    );
    err.code = "HARNESS_UNSUPPORTED";
    throw err;
  }
  if (capsule && caps.context_isolation !== CONTEXT_ISOLATION_CAPABILITY) {
    const err = new Error(
      `HARNESS_CONTEXT_ISOLATION_UNVERIFIED: ${cli} lacks verified context isolation`
    );
    err.code = "HARNESS_CONTEXT_ISOLATION_UNVERIFIED";
    throw err;
  }
  if (!broker && !capsule) {
    return { argv, env: {}, files: [], adapter: adapter.id, capabilities: caps };
  }
  const brokeredArgv =
    typeof adapter.sanitizeBrokeredArgv === "function"
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
