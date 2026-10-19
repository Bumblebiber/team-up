import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clearMarkAction, markLimitedAction, markTargets, runAction } from "../../src/dashboard/actions.mjs";
import { loadState } from "../../src/runs/runs.mjs";

const roster = {
  clis: { claude: { cmd: ["claude"] } },
  models: { "claude-opus": { cli: ["claude"], provider: "anthropic" } },
};
const home = process.env.TEAM_UP_HOME;

test("mark-limited takes only roster names and a bounded duration; clearing lifts the mark", () => {
  assert.deepEqual(markTargets(roster), ["anthropic", "claude", "claude-opus"]);
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(markLimitedAction({ target: "claude", hours: 2 }, { roster, now }).until, "2026-10-10T14:00:00.000Z");
  const usage = JSON.parse(fs.readFileSync(path.join(home, "usage.json"), "utf8"));
  assert.equal(usage.marked.claude.reason, "marked in the dashboard");
  assert.throws(() => markLimitedAction({ target: "ghost", hours: 2 }, { roster }), /unknown model/);
  assert.throws(() => markLimitedAction({ target: "claude", hours: 0 }, { roster }), /hours/);
  clearMarkAction({ target: "claude" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "usage.json"), "utf8")).marked, {});
  assert.throws(() => clearMarkAction({ target: "claude" }), /not marked/);
});

function plant(runId, status) {
  const dir = path.join(home, "runs", runId);
  fs.mkdirSync(path.join(dir, "mailbox"), { recursive: true });
  fs.writeFileSync(path.join(dir, "STATE.json"), JSON.stringify({ runId, version: 1, role: "reviewer", status, _stateRevision: 1 }));
}

test("run actions: cancel and fail only open runs, fail needs a reason, collect only finished ones", () => {
  plant("20261010T120000Z-aaaa", "watching");
  assert.throws(() => runAction("20261010T120000Z-aaaa", "fail"), /needs a reason/);
  assert.throws(() => runAction("20261010T120000Z-aaaa", "collect"), /only a finished run/);
  assert.equal(runAction("20261010T120000Z-aaaa", "fail", { reason: "stuck\non a prompt" }).status, "failed");
  assert.equal(loadState("20261010T120000Z-aaaa").failure.error, "stuck on a prompt");
  assert.throws(() => runAction("20261010T120000Z-aaaa", "cancel"), /already failed/);
  runAction("20261010T120000Z-aaaa", "collect");
  assert.ok(loadState("20261010T120000Z-aaaa").collected);
  assert.throws(() => runAction("../etc", "cancel"), /invalid run id/);
  assert.throws(() => runAction("20261010T120000Z-aaaa", "rm"), /unknown action/);
});

test("answer writes ANSWER.md and puts a waiting run back on watch; refused once it no longer waits", () => {
  plant("20261013T120000Z-ansr", "waiting_human");
  assert.throws(() => runAction("20261013T120000Z-ansr", "answer", { reason: "  " }), /needs text/);
  assert.equal(runAction("20261013T120000Z-ansr", "answer", { reason: "Use option B." }).status, "watching");
  const answer = fs.readFileSync(path.join(home, "runs", "20261013T120000Z-ansr", "mailbox", "ANSWER.md"), "utf8");
  assert.match(answer, /Use option B\./);
  assert.throws(() => runAction("20261013T120000Z-ansr", "answer", { reason: "again" }), /^Error: already answered$/);
  assert.match(fs.readFileSync(path.join(home, "runs", "20261013T120000Z-ansr", "mailbox", "ANSWER.md"), "utf8"), /option B/);
  plant("20261013T120000Z-cpty", "waiting_decision");
  assert.throws(() => runAction("20261013T120000Z-cpty", "answer", { reason: "x" }), /no longer waiting \(waiting_decision\)/);
});

test("retry answers only an observer's problem, with a fixed text; a worker's question needs a real answer", () => {
  const mb = (id) => path.join(home, "runs", id, "mailbox");
  plant("20261019T120000Z-stck", "waiting_human");
  fs.writeFileSync(path.join(mb("20261019T120000Z-stck"), "QUESTIONS.md"), "<!-- source: observer -->\n\nTrust this folder?\n");
  plant("20261019T120000Z-askd", "waiting_human");
  fs.writeFileSync(path.join(mb("20261019T120000Z-askd"), "QUESTIONS.md"), "# A or B?\n");
  assert.throws(() => runAction("20261019T120000Z-askd", "retry"), /a question needs an answer/);
  assert.equal(runAction("20261019T120000Z-stck", "retry").status, "watching");
  const answer = fs.readFileSync(path.join(mb("20261019T120000Z-stck"), "ANSWER.md"), "utf8");
  assert.match(answer, /^<!-- source: human \(dashboard retry\) -->\nRetry: the stop was a technical problem/);
  assert.throws(() => runAction("20261019T120000Z-stck", "retry"), /already answered/);
});

test("merged and discarded also mark the result read; never on a run still going", () => {
  plant("20261019T130000Z-mrgd", "done");
  plant("20261019T130000Z-busy", "watching");
  runAction("20261019T130000Z-mrgd", "merged");
  const state = loadState("20261019T130000Z-mrgd");
  assert.equal(state.outcome.value, "merged");
  assert.ok(state.collected);
  assert.throws(() => runAction("20261019T130000Z-busy", "discarded"), /still watching/);
  assert.equal(loadState("20261019T130000Z-busy").outcome, undefined);
});
