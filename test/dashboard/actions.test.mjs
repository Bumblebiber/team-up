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
  fs.writeFileSync(path.join(home, "runs", "20261013T120000Z-ansr", "mailbox", "QUESTIONS.md"), "A or B?\n");
  assert.throws(() => runAction("20261013T120000Z-ansr", "answer", { reason: "  " }), /needs text/);
  assert.equal(runAction("20261013T120000Z-ansr", "answer", { reason: "Use option B." }).status, "watching");
  const answer = fs.readFileSync(path.join(home, "runs", "20261013T120000Z-ansr", "mailbox", "ANSWER.md"), "utf8");
  assert.match(answer, /Use option B\./);
  assert.throws(() => runAction("20261013T120000Z-ansr", "answer", { reason: "again" }), /^Error: already answered$/);
  assert.match(fs.readFileSync(path.join(home, "runs", "20261013T120000Z-ansr", "mailbox", "ANSWER.md"), "utf8"), /option B/);
  plant("20261013T120000Z-cpty", "waiting_decision");
  assert.throws(() => runAction("20261013T120000Z-cpty", "answer", { reason: "x" }), /no longer waiting \(waiting_decision\)/);
});

test("retry answers only a parked run's technical stop, with a fixed text; anything else is refused", () => {
  const mb = (id) => path.join(home, "runs", id, "mailbox");
  const stuck = (id, log = "") => {
    plant(id, "waiting_human");
    fs.writeFileSync(path.join(mb(id), "QUESTIONS.md"), "<!-- source: observer -->\n\nTrust this folder?\n");
    fs.writeFileSync(path.join(mb(id), "OBSERVATION.log"), log);
  };
  stuck("20261019T120000Z-stck");
  stuck("20261019T120000Z-live");
  stuck("20261019T120000Z-deny", `${JSON.stringify({ kind: "decision", action: "escalate", finding: "Billing: add credits" })}\n`);
  plant("20261019T120000Z-askd", "waiting_human");
  fs.writeFileSync(path.join(mb("20261019T120000Z-askd"), "QUESTIONS.md"), "# A or B?\n");
  const ledger = path.join(home, "reports", "usage-spender", "ledger.json");
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, JSON.stringify(["stck", "deny", "askd"].map((s) =>
    ({ run_id: `20261019T120000Z-${s}`, parked: "2026-10-19T12:10:00Z" }))));

  assert.throws(() => runAction("20261019T120000Z-askd", "retry"), /a question needs an answer/);
  assert.throws(() => runAction("20261019T120000Z-live", "answer", { reason: "go on" }), /retried or cancelled, not answered/);
  assert.throws(() => runAction("20261019T120000Z-deny", "answer", { reason: "yes" }), /retried or cancelled, not answered/);
  assert.throws(() => runAction("20261019T120000Z-live", "retry"), /only a run the usage-spender parked/);
  assert.throws(() => runAction("20261019T120000Z-deny", "retry"), /credential or billing prompt: cancel it instead/);
  assert.ok(!fs.existsSync(path.join(mb("20261019T120000Z-live"), "ANSWER.md")), "a refused retry writes nothing");
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
  // Intake collected it with the TIM entry it wrote: that link stays.
  plant("20261019T130000Z-took", "done");
  runAction("20261019T130000Z-took", "collect");
  const collected = loadState("20261019T130000Z-took").collected;
  runAction("20261019T130000Z-took", "discarded");
  assert.equal(loadState("20261019T130000Z-took").outcome.value, "discarded");
  assert.deepEqual(loadState("20261019T130000Z-took").collected, collected);
});
