// The Action Center: every run that waits on Benni — a question to answer, a
// decision to make, a result nobody has read — grouped by project, most urgent
// first. TIM entries (tasks, bugs, ideas, reviews) stay in the TIM panel.
//
// Pure: the server hands in the TIM view (buildTimView) and the run states.

import path from "node:path";
import { buildRunRow } from "./data.mjs";

/** Which group an item sits in; lower is shown first. */
export const KIND_RANK = { question: 0, decision: 1, result: 2 };

const NO_PROJECT = { label: "-", title: "Other runs", dir: null };

/**
 * A run's project: its own TIM label when it names one, else the TIM project
 * whose repo holds its cwd (worktrees inside the repo included).
 */
function runProject(state, projects) {
  const byLabel = projects.find((p) => p.label === state.project);
  if (byLabel) return byLabel;
  const cwd = String(state.cwd || "");
  return projects.find((p) => p.dir && (cwd === p.dir || cwd.startsWith(p.dir + path.sep))) ?? NO_PROJECT;
}

/**
 * @param timView   buildTimView() result, or { installed: false } — only for run → project
 * @param states    every run STATE
 * @param questionOf runId → the question text a waiting run asked (or null)
 */
export function buildActionCenter({ timView, states, questionOf = () => null, now = Date.now() }) {
  const projects = timView?.installed ? timView.projects : [];
  const groups = new Map();
  const add = (project, item) => {
    const g = groups.get(project.label)
      ?? { label: project.label, title: String(project.title).split(/ \| | — /)[0], dir: project.dir, items: [] };
    g.items.push(item);
    groups.set(project.label, g);
  };

  for (const state of states) {
    const row = buildRunRow(state, { now });
    const role = String(state.role ?? "run").replace(/^specialist:/, "");
    const base = { runId: state.runId, role, worker: row.worker, age: row.age, priority: null, prank: 0 };
    if (state.status === "waiting_human" || state.status === "waiting_decision") {
      const kind = state.status === "waiting_human" ? "question" : "decision";
      add(runProject(state, projects), {
        ...base, kind, id: `run:${state.runId}`,
        title: `${role} is waiting for ${kind === "question" ? "your answer" : "a decision"}`,
        detail: questionOf(state.runId) || null,
      });
    } else if (row.uncollected) {
      add(runProject(state, projects), {
        ...base, kind: "result", id: `run:${state.runId}`, status: state.status,
        // A failed run first: it is the result most likely to need a reaction.
        prank: state.status === "failed" ? 0 : 1,
        title: `${role} ${state.status === "failed" ? "failed" : "finished"} — result not read yet`,
      });
    }
  }

  const order = (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.prank - b.prank;
  const result = [...groups.values()].map((g) => {
    g.items.sort(order);
    g.top = g.items[0];
    return g;
  });
  // A project ranks by its most urgent item; ties go alphabetically.
  result.sort((a, b) => order(a.top, b.top) || a.title.localeCompare(b.title));
  for (const g of result) delete g.top;

  const counts = { question: 0, decision: 0, result: 0 };
  for (const g of result) for (const i of g.items) counts[i.kind] += 1;
  return { projects: result, counts };
}
