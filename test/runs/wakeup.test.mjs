import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildParentPlan,
  parentDelivery,
  parentKey,
  parentResumeArgv,
  renderParentWakeup,
  workerOutcome,
  writeOverflow,
} from "../../src/runs/wakeup.mjs";
import { deliverParentWakeup } from "../../src/runs/runs.mjs";

const P1 = { cli: "claude", sessionId: "s-1", tmux: "main", attach: "tmux", cwd: "/home/u/proj" };
const P2 = { cli: "claude", sessionId: "s-2", tmux: null, attach: "manual", cwd: "/home/u/other" };

function run(runId, parent, extra = {}) {
  return { runId, status: "watching", createdAt: `2026-10-01T09:${runId.slice(-2)}:00Z`, role: "specialist:coding.codey", parent, worker: { cli: "codex", tmux: `team-up-${runId}` }, ...extra };
}

test("parentKey prefers the session id and falls back to tmux", () => {
  assert.equal(parentKey(P1), "claude:s-1");
  assert.equal(parentKey({ cli: "codex", tmux: "t", attach: "tmux" }), "tmux:t");
  assert.equal(parentKey({ cli: "manual", attach: "manual" }), null);
});

test("delivery: spawn, alive, pending, none", () => {
  const gone = () => false;
  assert.equal(parentDelivery(P1, { tmuxExists: gone }), "spawn");
  assert.equal(parentDelivery(P1, { tmuxExists: () => true }), "alive");
  assert.equal(parentDelivery(P2, { tmuxExists: gone }), "pending");
  assert.equal(parentDelivery({ ...P2, cli: "codex" }, { tmuxExists: gone }), "none");
  assert.equal(parentDelivery({ ...P1, sessionId: null }, { tmuxExists: gone }), "none");
  assert.equal(parentDelivery({ ...P1, cli: "opencode-x" }, { tmuxExists: gone }), "none");
});

test("three runs of one parent are one group; two parents two groups", () => {
  const states = [run("r-03", P1), run("r-01", P1), run("r-02", P1), run("r-04", P2), run("r-05", P1, { status: "done" })];
  const plan = buildParentPlan(states, {
    tmuxExists: () => false,
    uncollected: [{ runId: "r-09", parent: P1 }, { runId: "r-08", parent: { cli: "x" } }],
  });
  assert.equal(plan.length, 2);
  const [first, second] = plan;
  assert.deepEqual(first.runIds, ["r-01", "r-02", "r-03"]);
  assert.equal(first.delivery, "spawn");
  assert.deepEqual(first.uncollected, ["r-09"]);
  assert.deepEqual(second.runIds, ["r-04"]);
  assert.equal(second.delivery, "pending");
});

test("the newest run's parent record wins inside a group", () => {
  const plan = buildParentPlan([run("r-01", P1), run("r-02", { ...P1, tmux: "main-2" })], { tmuxExists: () => false });
  assert.equal(plan[0].parent.tmux, "main-2");
});

test("workerOutcome names what the resume did", () => {
  const tmuxExists = (n) => n === "team-up-r-02";
  assert.equal(workerOutcome(run("r-01", P1), [{ kind: "spawn_worker" }], { tmuxExists }), "restarted");
  assert.equal(workerOutcome(run("r-02", P1), [], { tmuxExists }), "still running");
  assert.equal(workerOutcome(run("r-03", P1), [], { tmuxExists }), "no live worker");
  assert.equal(workerOutcome(run("r-04", P1, { status: "waiting_human" }), [], { tmuxExists }), "waiting on a human answer");
  assert.equal(
    workerOutcome(run("r-05", P1, { status: "waiting_capacity", capacity: { resume_not_before: "2026-10-01T12:00:00Z" } }), [], { tmuxExists }),
    "waiting for capacity until 2026-10-01T12:00:00Z",
  );
});

test("the wake-up message lists runs, watcher commands, unread results", () => {
  const message = renderParentWakeup({
    entries: [
      { state: run("r-01", P1), outcome: "restarted" },
      { state: run("r-02", P1, { role: "testing.tessa", status: "waiting_human" }), outcome: "waiting on a human answer" },
    ],
    uncollected: ["r-09"],
    restartReport: { verdict: "team_up_suspected", path: "/h/.team-up/logs/restart-b.json" },
  });
  assert.equal(message, [
    "Your session was resumed by team-up after a system restart (verdict: team_up_suspected — see /h/.team-up/logs/restart-b.json).",
    "",
    "You had 2 team-up runs in flight. Your watcher subagents did not survive.",
    "For each run below, re-spawn ONE cheap watcher subagent whose only job is",
    "the command shown (skill `dispatch`, Path B):",
    "",
    "- run r-01  coding.codey  worker tmux: team-up-r-01 (restarted)",
    "    team-up runs wait r-01 --ceiling-sec 7200",
    "- run r-02  testing.tessa  worker tmux: team-up-r-02 (waiting on a human answer)",
    "    team-up runs wait r-02 --ceiling-sec 7200",
    "    It asked a question: re-surface it to the human; do not invent an answer.",
    "",
    "1 result finished before the crash and has not been read:",
    "    team-up runs uncollected   → then use skill `intake`",
    "",
    "Do not re-dispatch any of these runs.",
    "",
  ].join("\n"));
  assert.match(renderParentWakeup({ entries: [{ state: run("r-01", P1), outcome: "restarted" }] }), /^Your session was resumed by team-up after a restart\.\n\nYou had 1 team-up run in flight/);
});

test("beyond ten runs the list goes to a file and the message names it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-wakeup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entries = Array.from({ length: 12 }, (_, i) => ({ state: run(`r-${String(i).padStart(2, "0")}`, P1), outcome: "restarted" }));
  const file = path.join(dir, "wakeup.md");
  assert.equal(writeOverflow(entries.slice(0, 10), file), null);
  assert.equal(writeOverflow(entries, file), file);
  assert.equal(fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- run")).length, 12);
  const message = renderParentWakeup({ entries, overflowPath: file });
  assert.equal(message.split("\n").filter((l) => l.startsWith("- run")).length, 10);
  assert.match(message, new RegExp(`… 2 more, with their commands, in ${file}`));
  assert.ok(message.split("\n").length <= 40);
});

test("parentResumeArgv per CLI", () => {
  assert.deepEqual(parentResumeArgv({ cli: "claude", sessionId: "s" }, "m"), { argv: ["claude", "--resume", "s", "m"], paste: false });
  assert.deepEqual(parentResumeArgv({ cli: "codex", sessionId: "s" }, "m", "/p"), { argv: ["codex", "resume", "s", "-C", "/p", "m"], paste: false });
  assert.deepEqual(parentResumeArgv({ cli: "cursor", sessionId: "s" }, "m"), { argv: ["cursor-agent", "--resume", "s", "m"], paste: false });
  assert.deepEqual(parentResumeArgv({ cli: "hermes", sessionId: "s" }, "m"), { argv: ["hermes", "chat", "--resume", "s", "-q", "m"], paste: false });
  assert.equal(parentResumeArgv({ cli: "manual", sessionId: "s" }, "m"), null);
});

test("deliverParentWakeup spawns in the parent's own cwd, or leaves a pending file", () => {
  const calls = [];
  const out = deliverParentWakeup({ parent: P1, delivery: "spawn" }, "hello", {
    fallbackCwd: "/worker/cwd",
    run: (args) => calls.push(args),
    paste: () => calls.push("paste"),
  });
  assert.deepEqual(out, { cwd: "/home/u/proj", cwd_source: "parent" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 6), ["new-session", "-d", "-s", "main", "-c", "/home/u/proj"]);
  assert.equal(calls[0].at(-1), "claude --resume s-1 hello");
  assert.ok(!calls[0].includes("TEAMUP_WORKER=1"));

  const codex = [];
  deliverParentWakeup({ parent: { ...P1, cli: "codex", cwd: null }, delivery: "spawn" }, "hi", {
    fallbackCwd: "/worker/cwd",
    run: (args) => codex.push(args[5], args.at(-1)),
    paste: () => codex.push("paste"),
  });
  assert.deepEqual(codex, ["/worker/cwd", "codex resume s-1 -C /worker/cwd hi"]);

  const pending = deliverParentWakeup({ parent: P2, delivery: "pending" }, "later", { writePending: (id, text) => `${id}=${text}` });
  assert.deepEqual(pending, { pending: "s-2=later" });
  assert.equal(deliverParentWakeup({ parent: P1, delivery: "alive" }, "x"), null);
});
