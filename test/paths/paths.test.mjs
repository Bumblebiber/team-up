import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { resolveReadPath, resolveWritePath, teamUpHome, legacyO9kHome } from "../../src/paths.mjs";

test("resolveReadPath falls back to o9k when team-up missing", () => {
  const home = "/tmp/fake-home";
  const env = { HOME: home, TEAM_UP_HOME: path.join(home, ".team-up"), O9K_HOME: path.join(home, ".o9k") };
  const o9kPath = path.join(legacyO9kHome(env), "roster.json");
  const teamUpPath = path.join(teamUpHome(env), "roster.json");
  assert.equal(
    resolveReadPath({
      teamUpEnv: "TEAM_UP_ROSTER",
      o9kEnv: "O9K_ROSTER",
      teamUpRelative: "roster.json",
      o9kRelative: "roster.json",
      env,
      teamUpExists: false,
      o9kExists: true,
    }),
    o9kPath
  );
  assert.notEqual(teamUpPath, o9kPath);
});

test("resolveWritePath always targets team-up", () => {
  const home = "/tmp/fake-home";
  const env = { HOME: home, TEAM_UP_HOME: path.join(home, ".team-up") };
  const teamUpPath = path.join(teamUpHome(env), "roster.json");
  assert.equal(
    resolveWritePath({
      teamUpEnv: "TEAM_UP_ROSTER",
      teamUpRelative: "roster.json",
      env,
    }),
    teamUpPath
  );
});

test("explicit TEAM_UP env wins over legacy", () => {
  const env = {
    TEAM_UP_ROSTER: "/tmp/tu-roster.json",
    O9K_ROSTER: "/tmp/o9k-roster.json",
  };
  assert.equal(
    resolveReadPath({
      teamUpEnv: "TEAM_UP_ROSTER",
      o9kEnv: "O9K_ROSTER",
      teamUpRelative: "roster.json",
      o9kRelative: "roster.json",
      env,
      teamUpExists: false,
      o9kExists: false,
    }),
    "/tmp/tu-roster.json"
  );
});

// Regression: these three used to compute their paths from os.homedir()/HOME
// directly instead of going through paths.mjs, so a run with its own home
// still touched the real one. For the PTY lock that meant a test contended
// with the live usage watcher and usage refresh failed mid-handoff.
//
// This guards the path, not the isolation under contention — reproducing that
// needs a live lock holder. A fourth module growing its own homedir copy would
// slip past unless it is added here.
test("cross-process usage state stays inside TEAM_UP_HOME", async () => {
  const { ptyLockPath } = await import("../../src/usage/usage-pty-lock.mjs");
  const { watcherStatePath } = await import("../../src/usage/usage-procs.mjs");
  const { usageCollectDebouncePath } = await import("../../src/paths.mjs");
  const prev = process.env.TEAM_UP_HOME;
  const isolated = "/tmp/paths-test-home";
  process.env.TEAM_UP_HOME = isolated;
  try {
    const realHome = path.join(os.homedir(), ".team-up");
    for (const [name, resolve] of [
      ["pty lock", ptyLockPath],
      ["watcher state", watcherStatePath],
      ["collect debounce", usageCollectDebouncePath],
    ]) {
      const p = resolve();
      assert.equal(path.dirname(p), isolated, `${name} escaped TEAM_UP_HOME: ${p}`);
      assert.notEqual(path.dirname(p), realHome, `${name} used the real home`);
    }
  } finally {
    if (prev === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prev;
  }
});

test("runsRoot honours TEAM_UP_HOME, like every other path helper", async () => {
  // It used to read TEAM_UP_RUNS and then jump straight to the real home. A
  // test that redirected TEAM_UP_HOME and reached this one operated on the
  // caller's actual runs — which is how it was found.
  const { runsRoot } = await import("../../src/runs/runs.mjs");
  const prior = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = "/tmp/tu-isolation-probe";
  try {
    assert.equal(runsRoot(), "/tmp/tu-isolation-probe/runs");
  } finally {
    if (prior === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prior;
  }
});

test("an explicit TEAM_UP_RUNS still wins over the home", async () => {
  const { runsRoot } = await import("../../src/runs/runs.mjs");
  const priorHome = process.env.TEAM_UP_HOME;
  const priorRuns = process.env.TEAM_UP_RUNS;
  process.env.TEAM_UP_HOME = "/tmp/tu-home";
  process.env.TEAM_UP_RUNS = "/tmp/tu-explicit-runs";
  try {
    assert.equal(runsRoot(), "/tmp/tu-explicit-runs");
  } finally {
    if (priorHome === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = priorHome;
    if (priorRuns === undefined) delete process.env.TEAM_UP_RUNS;
    else process.env.TEAM_UP_RUNS = priorRuns;
  }
});
