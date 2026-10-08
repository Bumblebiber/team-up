import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (…/team-up) — templates and example config live here. */
export function packageRoot(fromUrl = import.meta.url) {
  // paths.mjs lives at src/paths.mjs → package root is parent of src/
  return path.resolve(path.dirname(fileURLToPath(fromUrl)), "..");
}

export function teamUpHome(env = process.env) {
  return env.TEAM_UP_HOME || path.join(os.homedir(), ".team-up");
}

/** Prefer primary env, then legacy env, else null (caller supplies default). */
export function legacyAwarePath(primary, legacy, env = process.env) {
  return env[primary] || env[legacy] || null;
}

/**
 * Read path: explicit env (TEAM_UP_* or O9K_*) wins; otherwise use ~/.team-up.
 */
export function resolveReadPath({
  teamUpEnv,
  o9kEnv,
  teamUpRelative,
  env = process.env,
} = {}) {
  const forced = legacyAwarePath(teamUpEnv, o9kEnv, env);
  if (forced) return forced;
  return path.join(teamUpHome(env), teamUpRelative);
}

/** Write path: always ~/.team-up (or TEAM_UP_* override). Never writes ~/.o9k. */
export function resolveWritePath({
  teamUpEnv,
  teamUpRelative,
  env = process.env,
} = {}) {
  return env[teamUpEnv] || path.join(teamUpHome(env), teamUpRelative);
}

export function rosterPath(env = process.env) {
  return resolveReadPath({
    teamUpEnv: "TEAM_UP_ROSTER",
    o9kEnv: "O9K_ROSTER",
    teamUpRelative: "roster.json",
    env,
  });
}

export function rosterWritePath(env = process.env) {
  return resolveWritePath({
    teamUpEnv: "TEAM_UP_ROSTER",
    teamUpRelative: "roster.json",
    env,
  });
}

export function usagePath(env = process.env) {
  return resolveReadPath({
    teamUpEnv: "TEAM_UP_USAGE",
    o9kEnv: "O9K_USAGE",
    teamUpRelative: "usage.json",
    env,
  });
}

export function usageWritePath(env = process.env) {
  return resolveWritePath({
    teamUpEnv: "TEAM_UP_USAGE",
    teamUpRelative: "usage.json",
    env,
  });
}

export function modelsPath(env = process.env) {
  return resolveReadPath({
    teamUpEnv: "TEAM_UP_MODELS",
    o9kEnv: "O9K_MODELS",
    teamUpRelative: "models.json",
    env,
  });
}

export function modelsWritePath(env = process.env) {
  return resolveWritePath({
    teamUpEnv: "TEAM_UP_MODELS",
    teamUpRelative: "models.json",
    env,
  });
}

export function runsPath(env = process.env) {
  return (
    legacyAwarePath("TEAM_UP_RUNS", "O9K_RUNS", env) ||
    path.join(teamUpHome(env), "runs")
  );
}

export function ptyLockPath(env = process.env) {
  return (
    legacyAwarePath("TEAM_UP_PTY_LOCK", "O9K_PTY_LOCK", env) ||
    path.join(teamUpHome(env), ".usage-pty.lock")
  );
}

/** Stop-hook debounce stamp for the claude usage collector. */
export function usageCollectDebouncePath(env = process.env) {
  return path.join(teamUpHome(env), ".usage-collect-claude.debounce");
}

export function usageWatcherStatePath(env = process.env) {
  return (
    legacyAwarePath("TEAM_UP_USAGE_WATCHER_STATE", "O9K_USAGE_WATCHER_STATE", env) ||
    path.join(teamUpHome(env), "usage-watcher.json")
  );
}

export function debugLogDir(env = process.env) {
  return path.join(teamUpHome(env), "logs");
}

/** Authoritative launch descriptors — outside worker-writable run dirs. */
export function launchDescriptorsRoot(env = process.env) {
  return (
    env.TEAM_UP_LAUNCH_DESCRIPTORS ||
    path.join(teamUpHome(env), "launch-descriptors")
  );
}

export function launchDescriptorDir(runId, env = process.env) {
  return path.join(launchDescriptorsRoot(env), runId);
}

export function capabilityPoolRoot(env = process.env) {
  return env.TEAM_UP_CAPABILITY_POOL ||
    path.join(teamUpHome(env), "capability-pool");
}

/** Project↔specialist approval records. */
export function specialistApprovalsPath(env = process.env) {
  return path.join(teamUpHome(env), "approvals.json");
}

export function capabilityAssignmentsPath(env = process.env) {
  return env.TEAM_UP_CAPABILITY_ASSIGNMENTS ||
    path.join(teamUpHome(env), "capability-assignments.json");
}

export function secretsPath(env = process.env) {
  if (env.TEAM_UP_SECRETS) return env.TEAM_UP_SECRETS;
  if (env.TEAM_UP_HOME) return path.join(env.TEAM_UP_HOME, "secrets.env");
  if (env === process.env) {
    return path.join(teamUpHome(env), "secrets.env");
  }
  return null;
}

/** Resource samples, one JSONL file per UTC day. */
export function telemetryDir(env = process.env) {
  return env.TEAM_UP_TELEMETRY || path.join(teamUpHome(env), "telemetry");
}

/** Agent sessions that may dispatch runs, keyed by the CLI's pid (plan 2). */
export function sessionsDir(env = process.env) {
  return path.join(teamUpHome(env), "sessions");
}
