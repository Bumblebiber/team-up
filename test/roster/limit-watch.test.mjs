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
import { detectHostCli, writeSessionRecord } from "../../src/runs/parent.mjs";
import { fakeProc, rmrf } from "../telemetry/fake-proc.mjs";

const SCRIPT = fileURLToPath(new URL("../../src/roster/limit-watch.mjs", import.meta.url));
const ROSTER_BIN = fileURLToPath(new URL("../../src/roster/roster.mjs", import.meta.url));

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
  usage.windows["claude:week"] = { used: 0.92, updated_at: new Date().toISOString() };
  fs.writeFileSync(usagePath, JSON.stringify(usage));
  // The SessionStart hook records the host CLI under its pid; the hook finds
  // it by walking up its own ancestry, which passes through this process.
  writeSessionRecord({ cli: "claude", sessionId: "s", cwd: dir, pid: process.pid, dir: path.join(dir, "sessions") });
  // No CLAUDE_PID: the registry alone must name the host.
  const out = run({ TEAM_UP_HOME: dir, TEAM_UP_ROSTER: rosterPath, TEAM_UP_USAGE: usagePath, CLAUDE_PID: "" });
  // The host's own window still reports — proof the hook ran to the end
  // rather than swallowing an error into silence.
  assert.match(out, /⚠️ team-up roster: claude:week at 92%/);
  assert.doesNotMatch(out, /⛔|stop working|codex/);
});

// Codex, Cursor and OpenCode agents run `team-up usage --check` themselves
// (skills/roster), so it has the hook's bug: a claude session told to stop
// because codex:weekly is at 100%.
test("usage --check scopes to the CLI its session registry names", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lw-"));
  const rosterPath = path.join(dir, "roster.json");
  const usagePath = path.join(dir, "usage.json");
  fs.writeFileSync(rosterPath, JSON.stringify({ models: {}, roles: {}, limits: { warn_at: 0.9, handoff_at: 0.95 } }));
  const usage = SPLIT();
  delete usage.windows["codex:5h"]; // stale: would start a real collect
  usage.windows["claude:week"] = { used: 0.92, updated_at: new Date().toISOString() };
  fs.writeFileSync(usagePath, JSON.stringify(usage));
  writeSessionRecord({ cli: "claude", sessionId: "s", cwd: dir, pid: process.pid, dir: path.join(dir, "sessions") });
  const out = execFileSync(process.execPath, [ROSTER_BIN, "usage", "--check"], {
    encoding: "utf8",
    env: { ...process.env, TEAM_UP_HOME: dir, TEAM_UP_ROSTER: rosterPath, TEAM_UP_USAGE: usagePath, CLAUDE_PID: "" },
  });
  assert.match(out, /⚠️ team-up roster: claude:week at 92%/);
  assert.doesNotMatch(out, /⛔|stop working|codex/);
});

// Without a session record detectParent says "manual": at SessionStart the
// hook that writes the record runs in parallel with this one, and a desktop
// Claude build's comm is its version ("2.1.286"), so no process name helps.
// Claude Code's CLAUDE_PID still names the host when it is our ancestor.
// tmux (10) → claude desktop build (20) → bash (30) → node hook (40)
const DESKTOP = [
  { pid: 10, ppid: 1, comm: "tmux: server", start: 100 },
  { pid: 20, ppid: 10, comm: "2.1.286", start: 200 },
  { pid: 30, ppid: 20, comm: "bash", start: 300 },
  { pid: 40, ppid: 30, comm: "node", start: 400 },
];

test("detectHostCli names claude from an ancestor CLAUDE_PID when no record exists", (t) => {
  const procRoot = fakeProc({ processes: DESKTOP });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lw-host-"));
  t.after(() => rmrf(procRoot, home));
  const dir = path.join(home, "sessions");
  const host = (env) => detectHostCli({ env: { TEAM_UP_HOME: home, ...env }, procRoot, dir, pid: 40 });
  assert.equal(host({ CLAUDE_PID: "20" }), "claude");
  assert.equal(host({}), null);
  // Inherited from elsewhere (a tmux server's env): not our session.
  assert.equal(host({ CLAUDE_PID: "99" }), null);
  // The Cursor CLI runs Claude Code hooks too: never scope that to claude.
  assert.equal(host({ CLAUDE_PID: "20", CURSOR_VERSION: "1.0" }), null);
  // cursor-agent's comm is node; its launcher exports CURSOR_INVOKED_AS to
  // every descendant, its shell tool included.
  assert.equal(host({ CLAUDE_PID: "20", CURSOR_INVOKED_AS: "cursor-agent" }), null);
  // A record still wins.
  writeSessionRecord({ cli: "cursor", sessionId: "c", pid: 20, procRoot, dir });
  assert.equal(host({ CLAUDE_PID: "20" }), "cursor");
});

function noRecordFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lw-"));
  const rosterPath = path.join(dir, "roster.json");
  const usagePath = path.join(dir, "usage.json");
  fs.writeFileSync(rosterPath, JSON.stringify({ models: {}, roles: {}, limits: { warn_at: 0.9, handoff_at: 0.95 } }));
  const usage = SPLIT();
  delete usage.windows["codex:5h"]; // stale: would start a real collect
  usage.windows["claude:week"] = { used: 0.92, updated_at: new Date().toISOString() };
  fs.writeFileSync(usagePath, JSON.stringify(usage));
  // No session record; this test process is the hook's parent, so its pid
  // stands in for the Claude CLI's.
  return { TEAM_UP_HOME: dir, TEAM_UP_ROSTER: rosterPath, TEAM_UP_USAGE: usagePath, CLAUDE_PID: String(process.pid) };
}

test("the hook scopes to claude from CLAUDE_PID before the session record exists", () => {
  const out = run(noRecordFixture());
  assert.match(out, /⚠️ team-up roster: claude:week at 92%/);
  assert.doesNotMatch(out, /⛔|stop working|codex/);
});

test("usage --check scopes to claude from CLAUDE_PID before the session record exists", () => {
  const out = execFileSync(process.execPath, [ROSTER_BIN, "usage", "--check"], {
    encoding: "utf8",
    env: { ...process.env, ...noRecordFixture() },
  });
  assert.match(out, /⚠️ team-up roster: claude:week at 92%/);
  assert.doesNotMatch(out, /⛔|stop working|codex/);
});
