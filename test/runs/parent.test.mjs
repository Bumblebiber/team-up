import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  SESSION_SCHEMA,
  ancestry,
  detectParent,
  findCliProcess,
  pruneSessionRecords,
  readSessionRecord,
  writeSessionRecord,
} from "../../src/runs/parent.mjs";
import { takePendingWakeup, writePendingWakeup } from "../../src/runs/pending.mjs";
import { runSessionStart } from "../../hooks/session-start.mjs";
import { BOOT, fakeProc, rmrf } from "../telemetry/fake-proc.mjs";

// tmux (10) → claude (20) → bash (30) → node team-up (40)
const CHAIN = [
  { pid: 10, ppid: 1, comm: "tmux: server", start: 100 },
  { pid: 20, ppid: 10, comm: "claude", start: 200 },
  { pid: 30, ppid: 20, comm: "bash", start: 300 },
  { pid: 40, ppid: 30, comm: "node", start: 400 },
];

function setup(t, processes = CHAIN) {
  const proc = fakeProc({ processes });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-parent-"));
  t.after(() => rmrf(proc, home));
  return { proc, home, dir: path.join(home, "sessions"), env: { TEAM_UP_HOME: home } };
}

test("ancestry walks ppid links and stops at pid 1", (t) => {
  const { proc } = setup(t);
  assert.deepEqual(ancestry(40, { procRoot: proc }).map((p) => p.pid), [40, 30, 20, 10]);
});

test("findCliProcess skips a shell between hook and CLI", (t) => {
  const { proc } = setup(t);
  assert.equal(findCliProcess(30, { procRoot: proc, cli: "claude" }).pid, 20);
  // Nothing named like a CLI: the direct parent.
  assert.equal(findCliProcess(10, { procRoot: proc, cli: "claude" }).pid, 10);
});

test("a registry record at depth 3 names the parent", (t) => {
  const { proc, dir, env } = setup(t);
  const record = writeSessionRecord({
    cli: "claude", sessionId: "abc-123", cwd: "/home/u/proj", pid: 20,
    tmux: { session: "main", pane: "%3" }, source: "startup", procRoot: proc, dir,
  });
  assert.equal(record.schema, SESSION_SCHEMA);
  assert.equal(record.pid_start, 200);
  assert.equal(record.boot_id, BOOT);
  assert.deepEqual(detectParent({ env, procRoot: proc, dir, pid: 40 }), {
    cli: "claude", sessionId: "abc-123", tmux: "main", attach: "tmux", cwd: "/home/u/proj", detected_by: "registry",
  });
});

test("a record outside tmux attaches manually", (t) => {
  const { proc, dir, env } = setup(t);
  writeSessionRecord({ cli: "claude", sessionId: "s1", cwd: "/p", pid: 20, procRoot: proc, dir });
  const parent = detectParent({ env, procRoot: proc, dir, pid: 40 });
  assert.equal(parent.attach, "manual");
  assert.equal(parent.sessionId, "s1");
});

test("stale records are ignored: other boot or reused pid", (t) => {
  const { proc, dir, env } = setup(t);
  writeSessionRecord({ cli: "claude", sessionId: "old", pid: 20, procRoot: proc, dir });
  const file = path.join(dir, "20.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...record, boot_id: "another-boot" }));
  let parent = detectParent({ env, procRoot: proc, dir, pid: 40 });
  assert.deepEqual(parent, { cli: "claude", sessionId: null, tmux: null, attach: "manual", cwd: null, detected_by: "none" });
  fs.writeFileSync(file, JSON.stringify({ ...record, pid_start: 999 }));
  parent = detectParent({ env, procRoot: proc, dir, pid: 40 });
  assert.equal(parent.detected_by, "none");
});

test("no CLI in the chain and no record: manual, never an invented id", (t) => {
  const { proc, dir, env } = setup(t, [
    { pid: 30, ppid: 1, comm: "bash" },
    { pid: 40, ppid: 30, comm: "node" },
  ]);
  assert.deepEqual(detectParent({ env, procRoot: proc, dir, pid: 40 }), {
    cli: "manual", sessionId: null, tmux: null, attach: "manual", cwd: null, detected_by: "none",
  });
});

test("pruneSessionRecords drops dead pids and earlier boots, keeps live ones", (t) => {
  const { proc, dir } = setup(t);
  writeSessionRecord({ cli: "claude", sessionId: "live", pid: 20, procRoot: proc, dir });
  writeSessionRecord({ cli: "claude", sessionId: "dead", pid: 77, procRoot: proc, dir });
  const other = path.join(dir, "30.json");
  writeSessionRecord({ cli: "claude", sessionId: "oldboot", pid: 30, procRoot: proc, dir });
  fs.writeFileSync(other, JSON.stringify({ ...JSON.parse(fs.readFileSync(other, "utf8")), boot_id: "x" }));
  assert.equal(pruneSessionRecords({ dir, procRoot: proc, dryRun: true }).length, 2);
  assert.equal(fs.readdirSync(dir).length, 3);
  const removed = pruneSessionRecords({ dir, procRoot: proc }).map((f) => path.basename(f)).sort();
  assert.deepEqual(removed, ["30.json", "77.json"]);
  assert.equal(readSessionRecord(20, { dir }).session_id, "live");
});

test("pending wake-ups are taken once and moved to delivered/", (t) => {
  const { env, home } = setup(t);
  assert.equal(takePendingWakeup("s1", { env }), null);
  writePendingWakeup("s1", "hello", { env });
  assert.equal(takePendingWakeup("s1", { env }), "hello\n");
  assert.equal(takePendingWakeup("s1", { env }), null);
  assert.equal(fs.readdirSync(path.join(home, "sessions", "delivered")).length, 1);
  assert.throws(() => writePendingWakeup("../x", "no", { env }), /invalid session id/);
  assert.equal(takePendingWakeup("../x", { env }), null);
});

test("the SessionStart hook records the session and hands over a pending message", (t) => {
  const { proc, home, env } = setup(t);
  const tmuxEnv = { ...env, TMUX: "/tmp/tmux-0/default,1,0", TMUX_PANE: "%3" };
  const exec = (cmd, args) => {
    assert.equal(cmd, "tmux");
    assert.deepEqual(args, ["display-message", "-p", "-t", "%3", "#S"]);
    return "main\n";
  };
  const input = JSON.stringify({ session_id: "abc", cwd: "/p", source: "startup", hook_event_name: "SessionStart" });
  // Hook runs under `sh -c` (pid 30) below claude (pid 20).
  assert.equal(runSessionStart({ input, env: tmuxEnv, ppid: 30, procRoot: proc, exec }), null);
  const record = readSessionRecord(20, { dir: path.join(home, "sessions") });
  assert.equal(record.session_id, "abc");
  assert.deepEqual(record.tmux, { session: "main", pane: "%3" });

  writePendingWakeup("abc", "you were restarted", { env });
  const out = runSessionStart({ input, env, ppid: 30, procRoot: proc });
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "you were restarted\n" },
  });
  assert.equal(readSessionRecord(20, { dir: path.join(home, "sessions") }).tmux, null);
});

test("the hook process exits 0 and logs on bad input", (t) => {
  const { home } = setup(t);
  const script = new URL("../../hooks/session-start.mjs", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [script], { input: "not json", env: { ...process.env, TEAM_UP_HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(fs.readFileSync(path.join(home, "logs", "hooks.log"), "utf8"), /session-start error/);
});
