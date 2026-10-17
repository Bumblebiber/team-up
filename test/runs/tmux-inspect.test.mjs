import test from "node:test";
import assert from "node:assert/strict";
import { inspectTmuxSession } from "../../src/runs/tmux.mjs";
import { evaluateGcAction, IDLE_MS } from "../../src/runs/gc.mjs";

test("a session tmux reports as empty does not exist", () => {
  // Measured against tmux on this host: `display-message -p -t <dead-session>`
  // exits 0 and prints nothing. Only `has-session` reports absence as failure,
  // so catching a thrown error is not enough to decide a session is gone.
  const observed = inspectTmuxSession("gone", { exec: () => "" });
  assert.deepEqual(observed, { exists: false, activityMs: null, sessionId: null, attached: false });
});

test("whitespace-only output is absence too", () => {
  assert.equal(inspectTmuxSession("gone", { exec: () => "  \n" }).exists, false);
});

test("a thrown error is still absence", () => {
  const observed = inspectTmuxSession("gone", {
    exec: () => {
      throw new Error("can't find session");
    },
  });
  assert.equal(observed.exists, false);
});

test("a live session keeps its activity and id", () => {
  const observed = inspectTmuxSession("alive", { exec: () => "1788005239 $5 0\n" });
  assert.deepEqual(observed, {
    exists: true,
    activityMs: 1788005239000,
    sessionId: "$5",
    attached: false,
  });
});

test("a finished run whose terminal is already gone is skipped, not killed forever", () => {
  const state = { runId: "r1", status: "done" };
  // This is the loop the empty-output bug caused: gc decided kill_terminal,
  // `tmux kill-session` failed because the session was already gone, so the run
  // was never marked cleaned and came back on every five-minute timer tick.
  const gone = inspectTmuxSession("gone", { exec: () => "" });
  assert.deepEqual(
    evaluateGcAction({ state, nowMs: Date.now(), heartbeatMs: 0, tmux: gone }),
    { kind: "skip" }
  );

  const alive = inspectTmuxSession("alive", { exec: () => "1788005239 $5 0\n" });
  assert.deepEqual(
    evaluateGcAction({ state, nowMs: Date.now(), heartbeatMs: 0, tmux: alive }),
    { kind: "kill_terminal" }
  );
});

test("an active run with a vanished terminal is not judged on a phantom session", () => {
  // `!tmux.exists` is the early skip for active runs. With the bug it never
  // fired, so staleness was decided from a session that was not there.
  const state = { runId: "r2", status: "watching" };
  const gone = inspectTmuxSession("gone", { exec: () => "" });
  assert.deepEqual(
    evaluateGcAction({
      state,
      nowMs: Date.now(),
      heartbeatMs: Date.now() - IDLE_MS * 2,
      tmux: gone,
    }),
    { kind: "skip" }
  );
});

test("targets are exact: gone x-abc never reaches live x-abcdef", async () => {
  const { tmuxSessionExists, tmuxCapture, tmuxSendKeys } = await import("../../src/runs/tmux.mjs");
  const live = "x-abcdef";
  // Fake tmux resolving like the real one except that "=" demands equality.
  const exec = (_cmd, args) => {
    const t = args[args.indexOf("-t") + 1].replace(/:$/, "");
    const hit = t.startsWith("=") ? t.slice(1) === live : live.startsWith(t);
    if (!hit) throw new Error("can't find session");
    return "pane";
  };
  assert.equal(tmuxSessionExists("x-abcdef", { exec }), true);
  assert.equal(tmuxSessionExists("x-abc", { exec }), false);
  assert.equal(tmuxCapture("x-abc", { exec }), null);
  assert.equal(tmuxSendKeys("x-abc", ["y"], { exec }), false);
});
