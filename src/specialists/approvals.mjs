import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { specialistApprovalsPath } from "../paths.mjs";
import { atomicWriteJson } from "../json-store.mjs";
import { resolveInstalled, loadInstalledManifest, verifyInstalledIntegrity } from "./store.mjs";
import { resolveCommandPolicyForApproval } from "../commands/policy.mjs";

function loadApprovals(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(specialistApprovalsPath(env), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { approvals: {} };
    throw e;
  }
}

function saveApprovals(data, env = process.env) {
  atomicWriteJson(specialistApprovalsPath(env), data);
}

export function approvalKey({
  project,
  id,
  version,
  checksum,
  permissions,
  command_policy_checksum = null,
}) {
  const payload = JSON.stringify({
    project: path.resolve(project),
    id,
    version,
    checksum,
    permissions,
    command_policy_checksum: command_policy_checksum ?? null,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export async function approveSpecialist({ idAtVersion, project, env = process.env }) {
  const [id, version] = String(idAtVersion).split("@");
  if (!id || !version) {
    return { ok: false, errors: ["expected <id>@<version>"] };
  }
  // Resolve exact installed id@version. Project pin must not block approving
  // a different installed version before repin (approve-before-repin).
  const entry = resolveInstalled(id, { version, env });
  if (!entry || entry.version !== version) {
    return { ok: false, errors: [`not installed: ${id}@${version}`] };
  }

  // Load that exact entry without project pin override.
  const loaded = loadInstalledManifest(id, {
    version: entry.version,
    checksum: entry.checksum,
    env,
  });
  if (!loaded || loaded.version !== version) {
    return { ok: false, errors: [`not installed: ${id}@${version}`] };
  }

  try {
    verifyInstalledIntegrity(loaded, loaded.manifest);
  } catch (e) {
    return { ok: false, errors: [e.message], code: e.code || "PACKAGE_INTEGRITY_FAILED" };
  }

  let command_policy_checksum = null;
  try {
    ({ checksum: command_policy_checksum } = resolveCommandPolicyForApproval({
      project,
      permissions: loaded.manifest.permissions,
      env,
    }));
  } catch (e) {
    return { ok: false, errors: [e.message], code: e.code || "COMMAND_POLICY_INVALID" };
  }

  const key = approvalKey({
    project,
    id,
    version: loaded.version,
    checksum: loaded.checksum,
    permissions: loaded.manifest.permissions,
    command_policy_checksum,
  });
  const data = loadApprovals(env);
  data.approvals[key] = {
    project: path.resolve(project),
    id,
    version: loaded.version,
    checksum: loaded.checksum,
    permissions: loaded.manifest.permissions,
    command_policy_checksum,
    approved_at: new Date().toISOString(),
  };
  saveApprovals(data, env);
  return { ok: true, key, approval: data.approvals[key] };
}

export function isApproved({
  project,
  id,
  version,
  checksum,
  permissions,
  command_policy_checksum = null,
  env = process.env,
}) {
  const key = approvalKey({
    project,
    id,
    version,
    checksum,
    permissions,
    command_policy_checksum,
  });
  const data = loadApprovals(env);
  return Boolean(data.approvals?.[key]);
}

export function listApprovals(env = process.env) {
  return loadApprovals(env);
}
