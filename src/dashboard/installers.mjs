import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { teamUpHome, packageRoot } from "../paths.mjs";
import { tmuxSessionExists } from "../runs/tmux.mjs";
import { tmuxArgs } from "../roster/command.mjs";
import {
  HARNESS_VERIFY_CLIS,
  UNVERIFIABLE_ISOLATION_REASONS,
} from "../harness/cli-verify.mjs";
import { harnessStatus } from "../harness/registry.mjs";
import { loadVerificationRecord } from "../harness/verify.mjs";

/** Hardcoded per-CLI install/update/login table — browser sends only cli id. */
export const INSTALLERS = {
  claude: {
    bootstrap: {
      shell: "curl -fsSL https://claude.ai/install.sh | bash",
      confirmed: "2026-09-23",
      doc_url: "https://code.claude.com/docs/en/quickstart",
    },
    update: { shell: "claude update", confirmed: "2026-09-23" },
    login: { shell: "claude auth" },
  },
  cursor: {
    bootstrap: {
      shell: "curl -fsS https://cursor.com/install | bash",
      confirmed: "2026-09-23",
      doc_url: "https://cursor.com/docs/cli/installation",
    },
    update: { shell: "cursor-agent update", confirmed: "2026-09-23" },
    login: { shell: "NO_OPEN_BROWSER=1 cursor-agent login" },
  },
  opencode: {
    bootstrap: {
      shell: "curl -fsSL https://opencode.ai/install | bash",
      confirmed: "2026-09-23",
      doc_url: "https://opencode.ai/docs/",
    },
    update: { shell: "opencode upgrade", confirmed: "2026-09-23" },
    login: { shell: "opencode providers" },
  },
  codex: {
    bootstrap: {
      shell: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      confirmed: "2026-09-23",
      doc_url: "https://github.com/openai/codex#installing-and-running-codex-cli",
    },
    update: { shell: "codex update", confirmed: "2026-09-23" },
    login: { shell: "codex login" },
  },
  hermes: {
    bootstrap: {
      shell: [
        'git clone https://github.com/NousResearch/hermes-agent "$HERMES_DIR"',
        'cd "$HERMES_DIR"',
        "uv venv .venv",
        'uv pip install -e .',
        'mkdir -p "$HOME/.local/bin"',
        'printf \'#!/bin/sh\\nexec "$HERMES_DIR/.venv/bin/hermes" "$@"\\n\' > "$HOME/.local/bin/hermes"',
        "chmod +x \"$HOME/.local/bin/hermes\"",
      ].join(" && "),
      confirmed: "2026-09-23",
      doc_url: "https://github.com/NousResearch/hermes-agent",
      env: { HERMES_DIR: path.join(os.homedir(), ".hermes", "hermes-agent") },
    },
    update: null,
    login: null,
  },
};

const SECRET_PATTERNS = [
  /sk-or-[A-Za-z0-9_-]+/g,
  /sk-ant-[A-Za-z0-9_-]+/g,
  /sk-proj-[A-Za-z0-9_-]+/g,
  /Bearer [A-Za-z0-9_-]{20,}/g,
  /[0-9a-f]{48,}/gi,
];

export function installSessionName(cli) {
  return `team-up-install-${cli}`;
}

export function installLogPath(cli, env = process.env) {
  return path.join(teamUpHome(env), "logs", `install-${cli}.log`);
}

export function installExitPath(cli, env = process.env) {
  return `${installLogPath(cli, env)}.exit`;
}

export function isValidCliId(cli, roster) {
  return typeof cli === "string" && cli.length > 0 && Object.hasOwn(roster?.clis || {}, cli);
}

export function hermesTargetDir(env = process.env) {
  const spec = INSTALLERS.hermes?.bootstrap?.env?.HERMES_DIR;
  if (spec) return spec;
  return path.join(os.homedir(), ".hermes", "hermes-agent");
}

export function inspectHermesOccupied({ env = process.env, exec = execFileSync } = {}) {
  const target = hermesTargetDir(env);
  if (!fs.existsSync(target)) return null;
  let isGit = false;
  let branch = null;
  try {
    exec("git", ["-C", target, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    isGit = true;
    branch = exec("git", ["-C", target, "branch", "--show-current"], { encoding: "utf8" }).trim() || "(detached)";
  } catch {
    /* not a git repo */
  }
  return { path: target, is_git: isGit, branch };
}

export function hermesInstallRefusal({ env = process.env, exec = execFileSync } = {}) {
  const occupied = inspectHermesOccupied({ env, exec });
  if (!occupied) return null;
  const bits = [
    `target directory already exists: ${occupied.path}`,
    occupied.is_git ? "it is a git clone" : "it is not a git repository",
    occupied.branch ? `branch: ${occupied.branch}` : null,
  ].filter(Boolean);
  return {
    error: "hermes install refused — directory already exists",
    detail: `${bits.join("; ")}. Use git pull in that tree or remove it manually before a fresh install.`,
    occupied,
  };
}

export function bootstrapAvailable(cli, { allowInstall = false } = {}) {
  const spec = INSTALLERS[cli];
  if (!spec?.bootstrap?.shell) return { available: false, reason: "no bootstrap installer defined" };
  if (!spec.bootstrap.confirmed) {
    return {
      available: false,
      reason: `bootstrap not confirmed — see vendor docs at ${spec.bootstrap.doc_url || "vendor site"}`,
    };
  }
  if (!allowInstall) {
    return { available: false, reason: "bootstrap install requires --allow-install on team-up dashboard" };
  }
  return { available: true, command: spec.bootstrap.shell, doc_url: spec.bootstrap.doc_url };
}

export function updateAvailable(cli) {
  const spec = INSTALLERS[cli];
  if (!spec?.update?.shell) return { available: false, reason: "no update command" };
  return { available: true, command: spec.update.shell };
}

export function loginAvailable(cli) {
  const spec = INSTALLERS[cli];
  if (!spec?.login?.shell) return { available: false };
  return { available: true, command: spec.login.shell };
}

function parseLogIsolationReason(lines) {
  for (const line of lines || []) {
    const m = String(line).match(/context_isolation_reason:\s*(\S+)/);
    if (m) return m[1];
  }
  return null;
}

export function normalizeJobState(cli, state, logLines = []) {
  if (state.state !== "failed") return state;
  const reason = parseLogIsolationReason(logLines);
  if (reason && UNVERIFIABLE_ISOLATION_REASONS.has(reason)) {
    return { ...state, state: "succeeded", exit_code: 0, unverifiable_reason: reason };
  }
  if (logLines.some((l) => String(l).includes("harness verify unsupported"))) {
    return { ...state, state: "succeeded", exit_code: 0, unverifiable_reason: "no_verify_runner" };
  }
  return state;
}

export function installState(cli, {
  env = process.env,
  sessionExists = (s) => tmuxSessionExists(s, { exec: execFileSync }),
} = {}) {
  const session = installSessionName(cli);
  const logPath = installLogPath(cli, env);
  const exitPath = installExitPath(cli, env);
  const hasSession = sessionExists(session);
  let exitCode = null;
  try {
    const raw = fs.readFileSync(exitPath, "utf8").trim();
    if (raw !== "") exitCode = Number(raw);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (hasSession && exitCode === null) return { state: "running", session, log_path: logPath };
  if (exitCode !== null && !Number.isNaN(exitCode)) {
    const raw = {
      state: exitCode === 0 ? "succeeded" : "failed",
      exit_code: exitCode,
      session,
      log_path: logPath,
    };
    let logLines = [];
    try {
      logLines = fs.readFileSync(logPath, "utf8").split("\n");
    } catch {
      /* no log yet */
    }
    return normalizeJobState(cli, raw, logLines);
  }
  if (!hasSession && fs.existsSync(logPath)) {
    return { state: "interrupted", session, log_path: logPath };
  }
  return { state: "idle", session, log_path: logPath };
}

export function redactSecrets(text) {
  if (text == null || text === "") return text;
  let out = String(text);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export function readInstallLog(cli, { env = process.env, maxLines = 200 } = {}) {
  const logPath = installLogPath(cli, env);
  const exitPath = installExitPath(cli, env);
  let lines = [];
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    lines = raw.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const tail = lines.slice(-maxLines);
  let exitCode = null;
  try {
    const raw = fs.readFileSync(exitPath, "utf8").trim();
    if (raw !== "") exitCode = Number(raw);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return {
    lines: tail.map((l) => redactSecrets(l)),
    exit_code: exitCode,
    truncated: lines.length > maxLines,
    state: installState(cli, { env }).state,
  };
}

export function harnessVerifySupported(cli) {
  return HARNESS_VERIFY_CLIS.has(cli);
}

export function classifyVerificationVerdict(cli, {
  env = process.env,
  exec = execFileSync,
  isolationReason = null,
  logLines = null,
} = {}) {
  const fromLog = logLines ? parseLogIsolationReason(logLines) : null;
  if (fromLog && UNVERIFIABLE_ISOLATION_REASONS.has(fromLog)) {
    return {
      verdict: "harness_verification_unsupported",
      reason: fromLog,
      grants_revoked_by_design: true,
      rerun_helps: false,
    };
  }
  if (logLines?.some((l) => String(l).includes("harness verify unsupported"))) {
    return {
      verdict: "harness_verification_unsupported",
      reason: `harness verify has no runner for ${cli}`,
      grants_revoked_by_design: true,
      rerun_helps: false,
    };
  }
  if (!HARNESS_VERIFY_CLIS.has(cli)) {
    return {
      verdict: "harness_verification_unsupported",
      reason: `harness verify has no runner for ${cli}`,
      grants_revoked_by_design: true,
      rerun_helps: false,
    };
  }
  const reason = isolationReason
    ?? loadVerificationRecord(cli, harnessStatus(cli, { env, execFileSync: exec }).installed_version, env)
      ?.context_isolation_reason?.code
    ?? null;
  if (reason && UNVERIFIABLE_ISOLATION_REASONS.has(reason)) {
    return {
      verdict: "harness_verification_unsupported",
      reason,
      grants_revoked_by_design: true,
      rerun_helps: false,
    };
  }
  const status = harnessStatus(cli, { env, execFileSync: exec });
  if (status.status === "verified") {
    return { verdict: "verified", version: status.installed_version, rerun_helps: false };
  }
  const recordVersion = status.installed_version ?? status.record_version;
  const record = recordVersion ? loadVerificationRecord(cli, recordVersion, env) : null;
  const detail = record?.context_isolation_reason?.code || status.record_status || status.status;
  return {
    verdict: "failed",
    reason: detail,
    version: status.installed_version,
    rerun_helps: true,
    log_hint: installLogPath(cli, env),
  };
}

function harnessFixtureProject(env = process.env) {
  return path.join(packageRoot(), "test", "fixtures", "harness-project");
}

export function buildJobShell({
  cli,
  phase,
  env = process.env,
  teamUpBin = path.join(packageRoot(), "bin", "team-up.mjs"),
} = {}) {
  const spec = INSTALLERS[cli];
  if (!spec) throw new Error(`unknown cli: ${cli}`);
  const logPath = installLogPath(cli, env);
  const exitPath = installExitPath(cli, env);
  const sessionDir = teamUpHome(env);

  let inner;
  if (phase === "install") {
    const boot = spec.bootstrap;
    if (!boot?.shell) throw new Error("no bootstrap command");
    const prefix = boot.env
      ? Object.entries(boot.env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("; ")
      : "";
    inner = prefix ? `${prefix}; ${boot.shell}` : boot.shell;
  } else if (phase === "update") {
    const upd = spec.update?.shell;
    if (!upd) throw new Error("no update command");
    const fixture = harnessFixtureProject(env);
    const verifyCmd = `"${process.execPath}" "${teamUpBin}" harness verify ${cli} --fixture-project ${JSON.stringify(fixture)}`;
    if (HARNESS_VERIFY_CLIS.has(cli)) {
      inner = [
        `echo "=== phase: update ==="`,
        upd,
        `UPDATE_EXIT=$?`,
        `if [ $UPDATE_EXIT -ne 0 ]; then echo $UPDATE_EXIT > ${JSON.stringify(exitPath)}; exit $UPDATE_EXIT; fi`,
        `echo "=== phase: verify ==="`,
        verifyCmd,
        `VERIFY_EXIT=$?`,
        `echo $VERIFY_EXIT > ${JSON.stringify(exitPath)}`,
        `exit $VERIFY_EXIT`,
      ].join("; ");
    } else {
      inner = [
        `echo "=== phase: update ==="`,
        upd,
        `UPDATE_EXIT=$?`,
        `if [ $UPDATE_EXIT -ne 0 ]; then echo $UPDATE_EXIT > ${JSON.stringify(exitPath)}; exit $UPDATE_EXIT; fi`,
        `echo "=== phase: verify (skipped) ==="`,
        `echo "harness verify unsupported for ${cli}"`,
        `echo 0 > ${JSON.stringify(exitPath)}`,
      ].join("; ");
    }
  } else if (phase === "login") {
    const login = spec.login?.shell;
    if (!login) throw new Error("no login command");
    inner = login;
  } else {
    throw new Error(`unknown phase: ${phase}`);
  }

  if (phase !== "update") {
    inner = `${inner}; echo $? > ${JSON.stringify(exitPath)}`;
  }
  const wrapped = `( ${inner} ) 2>&1 | tee ${JSON.stringify(logPath)}`;
  return ["sh", "-c", wrapped];
}

export function spawnCliJob(cli, phase, {
  env = process.env,
  cwd = teamUpHome(env),
  exec = execFileSync,
  sessionExists = (s) => tmuxSessionExists(s, { exec }),
  teamUpBin,
} = {}) {
  const session = installSessionName(cli);
  if (sessionExists(session)) {
    return { ok: false, status: 409, error: "job already running", job: installState(cli, { env, sessionExists }) };
  }
  const logPath = installLogPath(cli, env);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  try {
    fs.unlinkSync(installExitPath(cli, env));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const argv = buildJobShell({ cli, phase, env, teamUpBin });
  const args = tmuxArgs({
    session,
    dir: cwd,
    argv,
    env: { TEAMUP_WORKER: "" },
  });
  exec("tmux", args, { stdio: "ignore" });
  return { ok: true, session, job: installState(cli, { env, sessionExists: () => true }) };
}

export function enrichCliRow(row, roster, { allowInstall = false, env = process.env } = {}) {
  const cli = row.cli;
  const boot = bootstrapAvailable(cli, { allowInstall });
  const upd = updateAvailable(cli);
  const state = installState(cli, { env });
  const login = loginAvailable(cli);
  let logLines = [];
  try {
    logLines = fs.readFileSync(installLogPath(cli, env), "utf8").split("\n");
  } catch {
    /* no log */
  }
  // The verdict is not only a post-update fact: a CLI that can never be
  // verified reads that way in the steady state too, and the row must not
  // call that "capabilities denied" — that is the wording for something a
  // rerun could fix.
  const verdict = classifyVerificationVerdict(cli, { env, logLines });
  const unsupported = verdict?.verdict === "harness_verification_unsupported";
  return {
    ...row,
    ...(unsupported
      ? { harness_label: `not verifiable — ${verdict.reason}` }
      : {}),
    verification_verdict: verdict,
    install_available: boot.available,
    install_command: boot.available ? boot.command : null,
    install_disabled_reason: boot.available ? null : boot.reason,
    update_available: upd.available,
    update_command: upd.available ? upd.command : null,
    login_available: login.available,
    login_command: login.available ? login.command : null,
    install_state: state.state,
    job_session: state.session,
    post_update_verdict: state.state === "succeeded" && upd.available ? verdict : null,
  };
}
