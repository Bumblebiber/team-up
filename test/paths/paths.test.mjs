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
