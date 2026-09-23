import fs from "node:fs";
import path from "node:path";
import { teamUpHome } from "../paths.mjs";
export function auditLogPath(env = process.env) {
  return path.join(teamUpHome(env), "dashboard-audit.log");
}

function ensureAuditFile(filePath) {
  try {
    fs.accessSync(filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (e) {
    if (e.code === "ENOENT") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "", { mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
    } else {
      throw e;
    }
  }
}

/**
 * Append one JSONL audit line. Never include secret values — hint only.
 */
export function appendAudit(event, { env = process.env, now = () => new Date() } = {}) {
  const filePath = auditLogPath(env);
  ensureAuditFile(filePath);
  const line = {
    ts: now().toISOString(),
    actor: event.actor || "127.0.0.1",
    action: event.action,
    target: event.target ?? null,
    result: event.result,
    ...(event.hint ? { hint: event.hint } : {}),
    ...(event.detail ? { detail: event.detail } : {}),
  };
  fs.appendFileSync(filePath, `${JSON.stringify(line)}\n`);
  return line;
}
