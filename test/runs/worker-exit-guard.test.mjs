import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GUARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/worker-exit-guard.sh");

function run(status, childScript) {
  const mb = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-guard-"));
  if (status !== null) fs.writeFileSync(path.join(mb, "STATUS"), status);
  const r = spawnSync("/bin/sh", [GUARD, mb, "/bin/sh", "-c", childScript], { encoding: "utf8", env: { ...process.env, MB: mb } });
  const read = (f) => (fs.existsSync(path.join(mb, f)) ? fs.readFileSync(path.join(mb, f), "utf8") : null);
  const out = { code: r.status, status: read("STATUS"), failure: read("FAILURE.md"), files: fs.readdirSync(mb).sort() };
  fs.rmSync(mb, { recursive: true, force: true });
  return out;
}

test("a worker that exits while the run is open closes it as failed, reason first", () => {
  for (const open of ["watching", "starting", "waiting_human"]) {
    const r = run(open, "exit 0");
    assert.equal(r.status, "failed", open);
    assert.match(r.failure, new RegExp(`exited with code 0 while STATUS was ${open}`));
    assert.equal(r.code, 0, "the guard keeps the worker's exit code");
    assert.deepEqual(r.files, ["FAILURE.md", "STATUS"], "no temp file left");
  }
});

test("a killed worker is reported by signal, an unstarted one as unset", () => {
  assert.match(run("watching", "kill -9 $$").failure, /killed by signal 9 while STATUS was watching/);
  const unset = run(null, "exit 3");
  assert.equal(unset.status, "failed");
  assert.match(unset.failure, /exited with code 3 while STATUS was unset/);
});

test("the worker's own terminal status and a parked run are left alone", () => {
  for (const kept of ["done", "failed", "cancelled", "waiting_capacity", "waiting_decision", "handing_off"]) {
    const r = run(kept, "exit 1");
    assert.equal(r.status, kept, kept);
    assert.equal(r.failure, null, kept);
  }
});

test("a worker that closes its own run before exiting keeps its word", () => {
  const r = run("watching", 'printf done > "$MB/STATUS"; exit 0');
  assert.equal(r.status, "done");
  assert.equal(r.failure, null);
});

const noTmux = spawnSync("tmux", ["-V"]).error ? "tmux not installed" : false;

test("behind the guard, timeout --foreground keeps the tty for a TUI, and kill-session still reaches it", { skip: noTmux }, async () => {
  const mb = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-guard-tty-"));
  fs.writeFileSync(path.join(mb, "STATUS"), "watching");
  const out = path.join(mb, "raw-ok");
  const session = `tu-guardtest-${process.pid}`;
  // What a claude/codex TUI does first: raw mode on its tty. In a background
  // process group that stops the process (SIGTTOU) and the file never appears.
  const tui = `process.stdin.setRawMode(true); require("fs").writeFileSync(${JSON.stringify(out)}, "ok"); setTimeout(() => {}, 60000)`;
  const sh = (args) => spawnSync("tmux", args, { encoding: "utf8" });
  const quote = (a) => `'${a.replaceAll("'", "'\\''")}'`;
  sh(["new-session", "-d", "-s", session, ["/bin/sh", GUARD, mb, "timeout", "--foreground", "0s", process.execPath, "-e", tui].map(quote).join(" ")]);
  try {
    for (let i = 0; i < 50 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(out), "the TUI got its tty");
  } finally {
    sh(["kill-session", "-t", `=${session}`]);
  }
  await new Promise((r) => setTimeout(r, 300));
  const left = spawnSync("pgrep", ["-f", out], { encoding: "utf8" }).stdout.trim();
  assert.equal(left, "", "kill-session left the CLI running");
  assert.equal(fs.readFileSync(path.join(mb, "STATUS"), "utf8"), "watching", "a kill is not a crash");
  fs.rmSync(mb, { recursive: true, force: true });
});
