import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const COMMAND_POLICY_FILE = ".team-up/commands.json";

const ACTION_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const FORBIDDEN_EXECUTABLES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);
const ACTION_KEYS = new Set(["argv", "cwd", "timeout_seconds", "environment"]);

function sortedCanonical(value) {
  if (Array.isArray(value)) return value.map(sortedCanonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortedCanonical(value[key]);
    }
    return out;
  }
  return value;
}

function isRelativeCwdSafe(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  if (path.isAbsolute(cwd)) return false;
  const normalized = path.posix.normalize(cwd.split(path.sep).join("/"));
  if (normalized === ".." || normalized.startsWith("../")) return false;
  if (normalized.includes("\0")) return false;
  return true;
}

export function validateCommandPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return { ok: false, errors: ["policy must be an object"] };
  }
  const keys = Object.keys(policy);
  if (keys.length !== 2 || !keys.includes("schema_version") || !keys.includes("commands")) {
    errors.push("top-level keys must be exactly schema_version and commands");
  }
  if (policy.schema_version !== 1) {
    errors.push("schema_version must be 1");
  }
  if (!policy.commands || typeof policy.commands !== "object" || Array.isArray(policy.commands)) {
    errors.push("commands must be an object");
    return { ok: false, errors };
  }

  for (const [actionId, action] of Object.entries(policy.commands)) {
    if (!ACTION_ID_RE.test(actionId)) {
      errors.push(`invalid action id: ${actionId}`);
      continue;
    }
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      errors.push(`action ${actionId} must be an object`);
      continue;
    }
    for (const key of Object.keys(action)) {
      if (!ACTION_KEYS.has(key)) {
        errors.push(`action ${actionId} has unknown key: ${key}`);
      }
    }
    for (const key of ACTION_KEYS) {
      if (!(key in action)) {
        errors.push(`action ${actionId} missing key: ${key}`);
      }
    }
    if (!Array.isArray(action.argv) || action.argv.length === 0 || !action.argv.every((a) => typeof a === "string")) {
      errors.push(`action ${actionId} argv must be a non-empty string array`);
    } else {
      const exe = path.basename(action.argv[0]);
      if (FORBIDDEN_EXECUTABLES.has(exe.toLowerCase())) {
        errors.push(`action ${actionId} refuses shell executable: ${exe}`);
      }
      if (action.argv.some((a) => a.includes("\0"))) {
        errors.push(`action ${actionId} argv must not contain NUL`);
      }
    }
    if (!isRelativeCwdSafe(action.cwd)) {
      errors.push(`action ${actionId} cwd must be relative and stay inside the project`);
    }
    if (!Number.isInteger(action.timeout_seconds) || action.timeout_seconds <= 0) {
      errors.push(`action ${actionId} timeout_seconds must be a positive integer`);
    }
    if (
      !action.environment ||
      typeof action.environment !== "object" ||
      Array.isArray(action.environment) ||
      Object.keys(action.environment).length !== 0
    ) {
      errors.push(`action ${actionId} environment must be an empty object in MVP`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function loadProjectCommandPolicy(project) {
  const policyPath = path.join(path.resolve(project), COMMAND_POLICY_FILE);
  if (!fs.existsSync(policyPath)) {
    const err = new Error(`COMMAND_POLICY_MISSING: ${policyPath}`);
    err.code = "COMMAND_POLICY_MISSING";
    throw err;
  }
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const result = validateCommandPolicy(policy);
  if (!result.ok) {
    const err = new Error(`COMMAND_POLICY_INVALID: ${result.errors.join("; ")}`);
    err.code = "COMMAND_POLICY_INVALID";
    err.errors = result.errors;
    throw err;
  }
  return { policy, path: policyPath, checksum: commandPolicyChecksum(policy) };
}

export function commandPolicyChecksum(policy) {
  const canonical = JSON.stringify(sortedCanonical(policy));
  return `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

export function snapshotCommandPolicy({ policy, runDir }) {
  const result = validateCommandPolicy(policy);
  if (!result.ok) {
    const err = new Error(`COMMAND_POLICY_INVALID: ${result.errors.join("; ")}`);
    err.code = "COMMAND_POLICY_INVALID";
    err.errors = result.errors;
    throw err;
  }
  const checksum = commandPolicyChecksum(policy);
  const dir = path.join(runDir, "policy");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "commands.json");
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(sortedCanonical(policy), null, 2)}\n`;
  fs.writeFileSync(tmp, body, { mode: 0o444 });
  fs.chmodSync(tmp, 0o444);
  fs.renameSync(tmp, target);
  try {
    fs.chmodSync(target, 0o444);
  } catch {
    // some filesystems ignore mode on rename
  }
  return { path: target, checksum };
}

export function actionFor(policy, actionId) {
  const action = policy?.commands?.[actionId];
  if (!action) {
    const err = new Error(`ACTION_DENIED: undeclared action ${actionId}`);
    err.code = "ACTION_DENIED";
    throw err;
  }
  return action;
}

/**
 * Resolve policy checksum for approval binding.
 * Specialists with no declared commands bind null (no project policy required).
 */
export function resolveCommandPolicyForApproval({ project, permissions, env: _env } = {}) {
  const commands = permissions?.commands || [];
  if (!commands.length) {
    return { checksum: null, policy: null };
  }
  const loaded = loadProjectCommandPolicy(project);
  for (const actionId of commands) {
    if (!loaded.policy.commands[actionId]) {
      const err = new Error(
        `COMMAND_POLICY_INCOMPLETE: project policy missing declared action ${actionId}`
      );
      err.code = "COMMAND_POLICY_INCOMPLETE";
      throw err;
    }
  }
  return { checksum: loaded.checksum, policy: loaded.policy, path: loaded.path };
}
