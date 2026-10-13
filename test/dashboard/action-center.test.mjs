import test from "node:test";
import assert from "node:assert/strict";
import { buildActionCenter, priorityRank } from "../../src/dashboard/action-center.mjs";

const now = Date.parse("2026-10-13T12:00:00Z");
const tim = (id, kind, status, priority, extra = {}) =>
  ({ id, kind, status, priority, title: id, sessions: [], prompt: "p", ...extra });

test("priority: P-levels and words share one scale, none sorts last", () => {
  assert.deepEqual(["P0", "high", "medium", "P3", null].map(priorityRank), [0, 1, 2, 3, 4]);
});

test("groups by project, questions first, projects ranked by their most urgent item", () => {
  const timView = {
    installed: true,
    projects: [
      { label: "P1", title: "Alpha | long", dir: "/r/alpha", items: [
        tim("a-idea", "idea", "new", null),
        tim("a-low", "task", "todo", "low"),
        tim("a-p0", "bug", "open", "P0"),
        tim("a-busy", "task", "in_progress", "P0", { sessions: ["s"] }),
        tim("a-review", "task", "review", "P2"),
      ] },
      { label: "P2", title: "Beta", dir: "/r/beta", items: [tim("b-task", "task", "todo", "P1")] },
    ],
  };
  const states = [
    { runId: "q1", role: "specialist:reviewer", status: "waiting_human", cwd: "/r/beta/.worktrees/x" },
    { runId: "r1", role: "writer", status: "done", project: "P1", finishedAt: "2026-10-12T00:00:00Z" },
    { runId: "old", role: "writer", status: "done", project: "P1", finishedAt: "2026-01-01T00:00:00Z" },
    { runId: "n1", role: "writer", status: "failed", cwd: "/elsewhere", finishedAt: "2026-10-13T00:00:00Z" },
  ];
  const ac = buildActionCenter({ timView, states, questionOf: (id) => (id === "q1" ? "A or B?" : null), now });

  assert.deepEqual(ac.projects.map((p) => p.title), ["Beta", "Alpha", "Other runs"]);
  const beta = ac.projects[0];
  assert.deepEqual(beta.items.map((i) => [i.kind, i.id]), [["question", "run:q1"], ["task", "b-task"]]);
  assert.equal(beta.items[0].detail, "A or B?");
  assert.equal(beta.items[0].role, "reviewer");
  assert.deepEqual(ac.projects[1].items.map((i) => i.id),
    ["a-review", "run:r1", "a-p0", "a-low", "a-idea"], "review is a decision; a live session drops out; old results expire");
  assert.deepEqual(ac.counts, { question: 1, decision: 1, result: 2, task: 2, bug: 1, idea: 1 });
});

test("no TIM: runs still show up", () => {
  const ac = buildActionCenter({ timView: { installed: false }, states: [{ runId: "q", status: "waiting_decision" }], now });
  assert.equal(ac.projects[0].items[0].kind, "decision");
});
