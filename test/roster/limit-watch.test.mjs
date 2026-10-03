// limit-watch.mjs contract: silent exit 0 without config; warning text on
// stdout when a provider crosses warn_at; never a non-zero exit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkThresholds } from "../../src/roster/chain.mjs";
import { writeSessionRecord } from "../../src/runs/parent.mjs";

const SCRIPT = fileURLToPath(new URL("../../src/roster/limit-watch.mjs", import.meta.url));

function run(env) {
  return execFileSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("silent when no roster config exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lw-"));
  const out = run({ O9K_ROSTER: path.join(dir, "none.json"), O9K_USAGE: path.join(dir, "none2.json") });
  assert.equal(out, "");
});

test("prints warning when a provider crosses warn_at", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lw-"));
  const rosterPath = path.join(dir, "roster.json");
  const usagePath = path.join(dir, "usage.json");
  fs.writeFileSync(rosterPath, JSON.stringify({
    models: {}, roles: {}, limits: { warn_at: 0.9, handoff_at: 0.95 },
  }));
  fs.writeFileSync(usagePath, JSON.stringify({ providers: { anthropic: { used: 0.92 } } }));
  const out = run({ O9K_ROSTER: rosterPath, O9K_USAGE: usagePath });
  assert.match(out, /anthropic at 92%/);
});

test("exit 0 even with corrupt usage.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lw-"));
  const rosterPath = path.join(dir, "roster.json");
  const usagePath = path.join(dir, "usage.json");
  fs.writeFileSync(rosterPath, JSON.stringify({ models: {}, roles: {} }));
  fs.writeFileSync(usagePath, "{not json");
  const out = run({ O9K_ROSTER: rosterPath, O9K_USAGE: usagePath });
  assert.equal(typeof out, "string"); // execFileSync throws on non-zero exit — reaching here IS the assertion
});

// The hook runs inside one CLI's session, but read every window in usage.json:
// with claude:session at 10% and codex:weekly at 100%, a healthy Claude Code
// session was told to write a handoff and "stop working in this session".
const SPLIT = () => {
  const updated_at = new Date().toISOString();
  return {
    windows: {
      "claude:session": { used: 0.1, updated_at },
      "codex:weekly": { used: 1, updated_at },
      "codex:5h": { used: 0.97, updated_at: "2026-01-01T00:00:00.000Z", resets_at: "2099-01-01T00:00:00.000Z" },
    },
  };
};

test("checkThresholds scoped to a host CLI ignores other CLIs' windows", () => {
  const roster = { limits: { warn_at: 0.9, handoff_at: 0.95 } };
  const claude = checkThresholds({ roster, usage: SPLIT(), hostCli: "claude" });
  assert.doesNotMatch(claude.message, /⛔|stop working/);
  assert.deepEqual(claude.needsRefresh, []);

  const codex = checkThresholds({ roster, usage: SPLIT(), hostCli: "codex" });
  assert.match(codex.message, /⛔ team-up roster: codex:weekly at 100%/);
  assert.match(codex.message, /stop working in this session/);
  assert.deepEqual(codex.needsRefresh, ["codex"]);

  // No host known: every window counts, as before.
  assert.match(checkThresholds({ roster, usage: SPLIT() }).message, /codex:weekly at 100%/);
});

test("the hook scopes to the CLI its session registry names", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lw-"));
  const rosterPath = path.join(dir, "roster.json");
  const usagePath = path.join(dir, "usage.json");
  fs.writeFileSync(rosterPath, JSON.stringify({ models: {}, roles: {}, limits: { warn_at: 0.9, handoff_at: 0.95 } }));
  const usage = SPLIT();
  delete usage.windows["codex:5h"]; // stale: would start a detached collect
  fs.writeFileSync(usagePath, JSON.stringify(usage));
  // The SessionStart hook records the host CLI under its pid; the hook finds
  // it by walking up its own ancestry, which passes through this process.
  writeSessionRecord({ cli: "claude", sessionId: "s", cwd: dir, pid: process.pid, dir: path.join(dir, "sessions") });
  const out = run({ TEAM_UP_HOME: dir, TEAM_UP_ROSTER: rosterPath, TEAM_UP_USAGE: usagePath });
  assert.doesNotMatch(out, /⛔|stop working/);
});
