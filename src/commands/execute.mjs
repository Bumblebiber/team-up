import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { actionFor, validateCommandPolicy } from "./policy.mjs";

export const MAX_CAPTURE = 1024 * 1024;
const ALLOWED_ENV = new Set(["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI"]);

function sanitizeEnvironment(base = process.env) {
  const env = {};
  for (const key of ALLOWED_ENV) {
    if (base[key] != null) env[key] = base[key];
  }
  return env;
}

/**
 * Bounded streaming accumulator — stops growing after `limit` bytes.
 */
export function createBoundedStream(limit = MAX_CAPTURE) {
  let buf = Buffer.alloc(0);
  let truncated = false;
  let dropped = 0;
  return {
    push(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (truncated) {
        dropped += incoming.length;
        return;
      }
      const room = limit - buf.length;
      if (incoming.length <= room) {
        buf = Buffer.concat([buf, incoming]);
        return;
      }
      if (room > 0) buf = Buffer.concat([buf, incoming.subarray(0, room)]);
      truncated = true;
      dropped += incoming.length - Math.max(room, 0);
    },
    result() {
      return {
        text: buf.toString("utf8"),
        truncated,
        bytes: buf.length,
        dropped,
      };
    },
  };
}

function appendAudit(runDir, record) {
  const dir = path.join(runDir, "audit");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "commands.jsonl"), `${JSON.stringify(record)}\n`);
}

function resolveActionCwd(project, cwd) {
  const root = path.resolve(project);
  const resolved = path.resolve(root, cwd || ".");
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const err = new Error("ACTION_DENIED: cwd escapes project root");
    err.code = "ACTION_DENIED";
    throw err;
  }
  return resolved;
}

/**
 * Execute one approved fixed-argv action without a shell.
 */
export async function executeApprovedAction({
  actionId,
  policy,
  project,
  runDir,
  env = process.env,
  maxCapture = MAX_CAPTURE,
}) {
  const validated = validateCommandPolicy(policy);
  if (!validated.ok) {
    const err = new Error(`COMMAND_POLICY_INVALID: ${validated.errors.join("; ")}`);
    err.code = "COMMAND_POLICY_INVALID";
    throw err;
  }
  const action = actionFor(policy, actionId);
  const cwd = resolveActionCwd(project, action.cwd);
  const argv = action.argv;
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeoutMs = action.timeout_seconds * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const stdoutAcc = createBoundedStream(maxCapture);
  const stderrAcc = createBoundedStream(maxCapture);
  let timedOut = false;

  try {
    const exit_code = await new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: sanitizeEnvironment(env),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        signal: controller.signal,
      });
      child.stdout.on("data", (chunk) => stdoutAcc.push(chunk));
      child.stderr.on("data", (chunk) => stderrAcc.push(chunk));
      child.on("error", (err) => {
        if (err.name === "AbortError" || controller.signal.aborted) {
          timedOut = true;
          const te = new Error(`COMMAND_TIMEOUT: action ${actionId} exceeded ${action.timeout_seconds}s`);
          te.code = "COMMAND_TIMEOUT";
          reject(te);
          return;
        }
        reject(err);
      });
      child.on("close", (code, signal) => {
        if (controller.signal.aborted || timedOut) {
          const te = new Error(`COMMAND_TIMEOUT: action ${actionId} exceeded ${action.timeout_seconds}s`);
          te.code = "COMMAND_TIMEOUT";
          reject(te);
          return;
        }
        if (signal) {
          resolve(128);
          return;
        }
        resolve(code ?? 1);
      });
    });

    const stdout = stdoutAcc.result();
    const stderr = stderrAcc.result();
    const finishedAt = new Date().toISOString();
    const result = {
      action_id: actionId,
      argv,
      cwd,
      shell: false,
      exit_code,
      stdout: stdout.text,
      stderr: stderr.text,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      started_at: startedAt,
      finished_at: finishedAt,
    };
    appendAudit(runDir, {
      action_id: actionId,
      argv,
      cwd,
      exit_code,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      started_at: startedAt,
      finished_at: finishedAt,
    });
    return result;
  } catch (e) {
    appendAudit(runDir, {
      action_id: actionId,
      argv,
      cwd,
      error: e.code || e.message,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
