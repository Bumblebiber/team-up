import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Package root (…/team-up) — templates and example config live here. */
export function packageRoot(fromUrl = import.meta.url) {
  // paths.mjs lives at src/paths.mjs → package root is parent of src/
  return path.resolve(path.dirname(fileURLToPath(fromUrl)), "..");
}

export function teamUpHome(env = process.env) {
  return env.TEAM_UP_HOME || path.join(os.homedir(), ".team-up");
}

export function legacyO9kHome(env = process.env) {
  return env.O9K_HOME || path.join(os.homedir(), ".o9k");
}

/** Prefer primary env, then legacy env, else null (caller supplies default). */
export function legacyAwarePath(primary, legacy, env = process.env) {
  return env[primary] || env[legacy] || null;
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Read path: explicit env (TEAM_UP_* or O9K_*) wins; else prefer ~/.team-up
 * file when present, else fall back to ~/.o9k for migration.
 */
export function resolveReadPath({
  teamUpEnv,
  o9kEnv,
  teamUpRelative,
  o9kRelative,
  env = process.env,
  teamUpExists,
  o9kExists,
} = {}) {
  const forced = legacyAwarePath(teamUpEnv, o9kEnv, env);
  if (forced) return forced;
  const teamUpPath = path.join(teamUpHome(env), teamUpRelative);
  const o9kPath = path.join(legacyO9kHome(env), o9kRelative);
  const tu = teamUpExists !== undefined ? teamUpExists : exists(teamUpPath);
  const o9 = o9kExists !== undefined ? o9kExists : exists(o9kPath);
  if (tu) return teamUpPath;
  if (o9) return o9kPath;
  return teamUpPath;
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
    o9kRelative: "roster.json",
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
    o9kRelative: "usage.json",
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

export function runsPath(env = process.env) {
  return (
    legacyAwarePath("TEAM_UP_RUNS", "O9K_RUNS", env) ||
    path.join(teamUpHome(env), "runs")
  );
}

export function scoresPath(env = process.env) {
  return resolveReadPath({
    teamUpEnv: "TEAM_UP_SCORES",
    o9kEnv: "O9K_SCORES",
    teamUpRelative: "scores.json",
    o9kRelative: "roster-scores.json",
    env,
  });
}

export function scoresWritePath(env = process.env) {
  return resolveWritePath({
    teamUpEnv: "TEAM_UP_SCORES",
    teamUpRelative: "scores.json",
    env,
  });
}

export function ptyLockPath(env = process.env) {
  return (
    legacyAwarePath("TEAM_UP_PTY_LOCK", "O9K_PTY_LOCK", env) ||
    path.join(teamUpHome(env), ".usage-pty.lock")
  );
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

export function capabilityAssignmentsPath(env = process.env) {
  return env.TEAM_UP_CAPABILITY_ASSIGNMENTS ||
    path.join(teamUpHome(env), "capability-assignments.json");
}
