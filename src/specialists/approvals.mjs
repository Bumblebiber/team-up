import fs from "node:fs";
import path from "node:path";
import { specialistPolicyTrustPath } from "../paths.mjs";
import { atomicWriteJson } from "../json-store.mjs";
import { resolveProjectCommandPolicy } from "../commands/policy.mjs";

function loadTrustData(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(specialistPolicyTrustPath(env), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

function saveTrustData(data, env = process.env) {
  atomicWriteJson(specialistPolicyTrustPath(env), data);
}

function canonical(project) {
  try {
    return fs.realpathSync(path.resolve(project));
  } catch {
    return path.resolve(project);
  }
}

/** Trust the current checksum of a project's command policy. */
export function trustProjectPolicy({ project, env = process.env } = {}) {
  if (typeof project !== "string" || !path.isAbsolute(project)) {
    return { ok: false, errors: ["project must be an absolute path"] };
  }

  let loaded;
  try {
    loaded = resolveProjectCommandPolicy(project);
  } catch (e) {
    return { ok: false, code: e.code || "COMMAND_POLICY_INVALID", errors: [e.message] };
  }

  const data = loadTrustData(env);
  const trustedAt = new Date().toISOString();
  data.trusted_policies = {
    ...(data.trusted_policies ?? {}),
    [loaded.checksum]: { project: canonical(project), trusted_at: trustedAt },
  };
  saveTrustData(data, env);
  return { ok: true, checksum: loaded.checksum, project: canonical(project), trusted_at: trustedAt };
}

/** Whether a policy checksum has an explicit project trust record. */
export function isPolicyTrusted({ checksum, env = process.env } = {}) {
  if (!checksum) return false;
  const data = loadTrustData(env);
  return Boolean(data.trusted_policies?.[checksum]);
}
