import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync as realExecFileSync } from "node:child_process";
import { claudeAdapter } from "./claude.mjs";
import { codexAdapter } from "./codex.mjs";
import { opencodeAdapter } from "./opencode.mjs";
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
  opencode: opencodeAdapter,
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
  {
    verification = undefined,
    env = process.env,
    execFileSync = realExecFileSync,
    requireExactVersion = undefined,
  } = {}
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
  if (record?.status !== "verified") {
    return { ...UNVERIFIED_CAPABILITIES };
  }

  // Verified records must bind exact adapter + cli_version. Missing is invalid.
  if (!Object.hasOwn(record, "adapter") || record.adapter == null || record.adapter === "") {
    return { ...UNVERIFIED_CAPABILITIES };
  }
  if (record.adapter !== adapter.id) {
    return { ...UNVERIFIED_CAPABILITIES };
  }
  if (
    !Object.hasOwn(record, "cli_version") ||
    record.cli_version == null ||
    record.cli_version === ""
  ) {
    return { ...UNVERIFIED_CAPABILITIES };
  }

  // Exact CLI version gate (successor/resume / explicit callers).
  if (requireExactVersion != null && record.cli_version !== requireExactVersion) {
    return { ...UNVERIFIED_CAPABILITIES };
  }

  const declared = adapter.capabilities;
  const verifiedBroker = Object.hasOwn(record, "command_broker")
    ? record.command_broker
    : (declared.command_broker ?? null);
  const verifiedIsolation = Object.hasOwn(record, "context_isolation")
    ? record.context_isolation
    : null;

  // Declared null is an absolute deny — never intersect upward.
  return {
    command_broker: declared.command_broker == null ? null : verifiedBroker,
    context_isolation: declared.context_isolation == null ? null : verifiedIsolation,
    native_shell: declared.native_shell,
    mcp: declared.mcp,
  };
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
  requireExactVersion = undefined,
  env = process.env,
  execFileSync = realExecFileSync,
  writeFileSync = fs.writeFileSync,
  mkdirSync = fs.mkdirSync,
  chmodSync = fs.chmodSync,
  nodePath = process.execPath,
  brokerBin = brokerBinPath(),
}) {
  const adapter = getAdapter(cli);
  if (verification && verification.status === "verified") {
    if (!verification.adapter) {
      const err = new Error(
        "HARNESS_VERIFICATION_ADAPTER: verified record missing adapter"
      );
      err.code = "HARNESS_VERIFICATION_ADAPTER";
      throw err;
    }
    if (verification.adapter !== adapter.id) {
      const err = new Error(
        `HARNESS_VERIFICATION_ADAPTER: record adapter ${verification.adapter} != runtime ${adapter.id}`
      );
      err.code = "HARNESS_VERIFICATION_ADAPTER";
      throw err;
    }
    if (!verification.cli_version) {
      const err = new Error(
        "HARNESS_VERIFICATION_VERSION: verified record missing cli_version"
      );
      err.code = "HARNESS_VERIFICATION_VERSION";
      throw err;
    }
  }
  const caps = harnessCapabilities(cli, {
    verification,
    env,
    execFileSync,
    requireExactVersion,
  });
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
