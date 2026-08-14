import fs from "node:fs";
import path from "node:path";
import { teamUpHome } from "../paths.mjs";
import { atomicWriteJson } from "../json-store.mjs";
import {
  COMMAND_BROKER_CAPABILITY,
  CONTEXT_ISOLATION_CAPABILITY,
} from "./capabilities.mjs";

export function verificationRecordPath(adapterId, cliVersion, env = process.env) {
  return path.join(
    teamUpHome(env),
    "harness-verification",
    adapterId,
    `${cliVersion}.json`
  );
}

export function loadVerificationRecord(adapterId, cliVersion, env = process.env) {
  const p = verificationRecordPath(adapterId, cliVersion, env);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function saveVerificationRecord(record, env = process.env) {
  const p = verificationRecordPath(record.adapter, record.cli_version, env);
  atomicWriteJson(p, record);
  return p;
}

/**
 * Run version-keyed conformance checks for an adapter.
 * `runner` is injectable so unit tests never invoke a paid model.
 */
export async function verifyHarness({
  adapter,
  fixtureProject,
  env = process.env,
  runner,
  now = new Date().toISOString(),
}) {
  if (typeof runner !== "function") {
    const err = new Error("verifyHarness requires an injectable runner in tests/CI");
    err.code = "VERIFY_RUNNER_REQUIRED";
    throw err;
  }
  const cliVersion = adapter.version({
    execFileSync: runner.execFileSync || (() => {
      throw new Error("missing execFileSync");
    }),
  });
  const checks = await runner({
    adapter,
    fixtureProject,
    cliVersion,
  });
  let status;
  if (checks.native_shell === "denied" && checks.broker_tool === "passed") {
    status = "verified";
  } else if (
    checks.native_shell === "unverified" ||
    checks.broker_tool === "unverified"
  ) {
    status = "unverified";
  } else {
    status = "failed";
  }
  const record = {
    adapter: adapter.id,
    cli_version: cliVersion,
    checked_at: now,
    native_shell: checks.native_shell,
    broker_tool: checks.broker_tool,
    context_isolation_check: checks.context_isolation ?? "unverified",
    command_broker: status === "verified" ? COMMAND_BROKER_CAPABILITY : null,
    // Context isolation is proven separately: a verified command broker never
    // implies the harness can also hide global capabilities.
    context_isolation:
      checks.context_isolation === "passed" ? CONTEXT_ISOLATION_CAPABILITY : null,
    status,
  };
  saveVerificationRecord(record, env);
  return record;
}
