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
