import "../helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmuxArgs, startInTmux, launcherPath, tmuxPaneCommand } from "../../src/roster/command.mjs";
import { createRun, cancelRun } from "../../src/runs/runs.mjs";
import { stopTmuxSession } from "../../src/runs/tmux.mjs";

// Quotes, $, backticks, newlines and umlauts: everything a shell could eat.
const PROMPT = `it's $HOME \`id\` "x"\nzweite Zeile: äöü ß\n`.repeat(2000);

test("a prompt past tmux's limit reaches the CLI byte-identical through a self-deleting launcher", () => {
  assert.ok(Buffer.byteLength(PROMPT) > 64 * 1024);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-long-"));
  const out = path.join(tmp, "argv.json");
  const fakeCli = [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(1)))`];
  const args = tmuxArgs({ session: "team-up-long-t1", dir: tmp, argv: [...fakeCli, "--", PROMPT] });

  const command = args.at(-1);
  assert.ok(Buffer.byteLength(command) < 1024, "tmux gets the launcher, not the prompt");
  const launcher = launcherPath("team-up-long-t1");
  assert.equal(command, tmuxPaneCommand(`sh ${launcher}`));
  assert.equal(fs.statSync(launcher).mode & 0o777, 0o600);

  execFileSync("sh", ["-c", command]);
  const received = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.ok(received.length === 1 && received[0] === PROMPT, "prompt arrives byte-identical");
  assert.equal(fs.existsSync(launcher), false, "launcher removes itself");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("an argument past the 128 KiB exec limit fails before tmux starts", () => {
  assert.throws(
    () => tmuxArgs({ session: "s", dir: "/tmp", argv: ["claude", "x".repeat(128 * 1024)] }),
    /128 KiB/,
  );
});

test("a failed tmux start drops the launcher", () => {
  const session = "team-up-long-t2";
  assert.throws(() => startInTmux({
    session,
    dir: "/tmp",
    argv: ["claude", PROMPT],
    exec: () => { throw new Error("duplicate session"); },
  }), /duplicate session/);
  assert.equal(fs.existsSync(launcherPath(session)), false);
});

test("stopTmuxSession names the session exactly, never by prefix", () => {
  const calls = [];
  stopTmuxSession("team-up-pinned-ab", { exec: (_, args) => calls.push(args) });
  assert.deepEqual(calls, [["kill-session", "-t", "=team-up-pinned-ab"]]);
});

test("cancel marks the run, then stops its recorded worker session", () => {
  const state = createRun({
    cwd: "/tmp/p", role: "dispatch",
    parent: { cli: "team-up", attach: "manual" },
    worker: { cli: "agy", tmux: "team-up-pinned-xyz" },
    prompt: "x",
  });
  const stopped = [];
  const after = cancelRun(state.runId, { stopTmux: (s) => stopped.push(s) });
  assert.equal(after.status, "cancelled");
  assert.deepEqual(stopped, ["team-up-pinned-xyz"]);

  const bare = createRun({ cwd: "/tmp/p", role: "dispatch", parent: { cli: "team-up", attach: "manual" }, worker: { cli: "agy" }, prompt: "x" });
  cancelRun(bare.runId, { stopTmux: (s) => stopped.push(s) });
  assert.deepEqual(stopped, ["team-up-pinned-xyz"], "no recorded session, nothing killed");
});

test("a worker with a run starts behind the exit guard; a session without one does not", () => {
  const state = createRun({
    cwd: "/tmp/p", role: "dispatch",
    parent: { cli: "team-up", attach: "manual" },
    worker: { cli: "codex" },
    prompt: "x",
  });
  const calls = [];
  startInTmux({ session: "team-up-guard-t1", dir: "/tmp", argv: ["codex", "hi"], runId: state.runId, exec: (_, args) => calls.push(args) });
  startInTmux({ session: "team-up-guard-t2", dir: "/tmp", argv: ["codex", "hi"], exec: (_, args) => calls.push(args) });
  assert.match(calls[0].at(-1), /^env -u CLAUDECODE .* -- \/bin\/sh \S+\/scripts\/worker-exit-guard\.sh \S+\/mailbox codex hi$/);
  assert.equal(calls[1].at(-1), tmuxPaneCommand("codex hi"));
});
