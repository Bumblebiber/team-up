import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { teamUpHome } from "../paths.mjs";
import { atomicWriteJson } from "../json-store.mjs";
import { resolveInstalled, loadInstalledManifest, verifyInstalledIntegrity } from "./store.mjs";

function approvalsPath(env = process.env) {
  return path.join(teamUpHome(env), "approvals.json");
}

function loadApprovals(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(approvalsPath(env), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { approvals: {} };
    throw e;
  }
}

function saveApprovals(data, env = process.env) {
  atomicWriteJson(approvalsPath(env), data);
}

export function approvalKey({ project, id, version, checksum, permissions }) {
  const payload = JSON.stringify({
    project: path.resolve(project),
    id,
    version,
    checksum,
    permissions,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export async function approveSpecialist({ idAtVersion, project, env = process.env }) {
  const [id, version] = String(idAtVersion).split("@");
  if (!id || !version) {
    return { ok: false, errors: ["expected <id>@<version>"] };
  }
  // Prefer project pin; fall back to explicit version match
  let entry = resolveInstalled(id, { version, project, env });
  if (!entry) {
    entry = resolveInstalled(id, { version, env });
  }
  if (!entry || entry.version !== version) {
    return { ok: false, errors: [`not installed: ${id}@${version}`] };
  }

  const loaded = loadInstalledManifest(id, {
    project,
    version: entry.version,
    checksum: entry.checksum,
    env,
  });
  if (!loaded) {
    return { ok: false, errors: [`not installed: ${id}@${version}`] };
  }

  try {
    verifyInstalledIntegrity(loaded, loaded.manifest);
  } catch (e) {
    return { ok: false, errors: [e.message], code: e.code || "PACKAGE_INTEGRITY_FAILED" };
  }

  const key = approvalKey({
    project,
    id,
    version: loaded.version,
    checksum: loaded.checksum,
    permissions: loaded.manifest.permissions,
  });
  const data = loadApprovals(env);
  data.approvals[key] = {
    project: path.resolve(project),
    id,
    version: loaded.version,
    checksum: loaded.checksum,
    permissions: loaded.manifest.permissions,
    approved_at: new Date().toISOString(),
  };
  saveApprovals(data, env);
  return { ok: true, key, approval: data.approvals[key] };
}

export function isApproved({ project, id, version, checksum, permissions, env = process.env }) {
  const key = approvalKey({ project, id, version, checksum, permissions });
  const data = loadApprovals(env);
  return Boolean(data.approvals?.[key]);
}

export function listApprovals(env = process.env) {
  return loadApprovals(env);
}
