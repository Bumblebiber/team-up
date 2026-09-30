import test from "node:test";
import assert from "node:assert/strict";
import { buildInsights, failureReason, normalizeReason } from "../../scripts/run-insights.mjs";

const NOW = new Date("2026-09-30T12:00:00Z");

function run(id, { cli = "cursor", model = "composer-2.5", status = "done", hoursAgo = 1, ...rest } = {}) {
  const createdAt = new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
  return { runId: id, role: "implementer", status, createdAt, worker: { cli, model }, ...rest };
}

const noObs = { stalls: 0, judgeCalls: 0, escalations: 0 };

test("the same cause counts once, whatever temp path or pid it carried", () => {
  assert.equal(
    normalizeReason("USAGE_REFRESH_FAILED: claude:Command failed: expect /tmp/o9k-usage-pty-claude-2560024.exp\nstack"),
    "USAGE_REFRESH_FAILED: claude:Command failed: expect <tmp>",
  );
});

test("legacy fields still yield a reason before the mailbox is consulted", () => {
  assert.equal(failureReason({ runId: "x", failure: { error: "boom" } }, "/nonexistent"), "boom");
  assert.equal(failureReason({ runId: "x", last_start_error: "LEASE_TRANSFER_FAILED: gone" }, "/nonexistent"), "LEASE_TRANSFER_FAILED: gone");
  assert.equal(failureReason({ runId: "x", cleanup: { stale_reason: "worker_stale_timeout" } }, "/nonexistent"), "worker_stale_timeout");
});

test("a failing model and a recurring reason inside the window become findings; old runs do not", () => {
  const states = [
    run("a", { status: "failed", failure: { error: "STATUS=failed" } }),
    run("b", { status: "failed", failure: { error: "STATUS=failed" } }),
    run("c"),
    run("old", { status: "failed", hoursAgo: 100 }),
    run("d", { cli: "claude", model: "claude-opus", outcome: { value: "merged" } }),
  ];
  const r = buildInsights(states, {
    now: NOW,
    runInfo: (s) => ({ reason: s.status === "failed" ? s.failure?.error ?? "unknown" : null, obs: noObs }),
  });
  assert.equal(r.totals.runs, 4);
  assert.equal(r.byModel["cursor:composer-2.5"].failRate, 0.67);
  const ids = r.findings.map((f) => f.id);
  assert.ok(ids.includes("fail_rate:cursor:composer-2.5"));
  assert.ok(ids.includes("recurring_failure:STATUS=failed"));
  assert.ok(!ids.some((id) => id.startsWith("fail_rate:claude")));
  assert.ok(!ids.includes("outcome_unrecorded"), "under 3 done runs is too few to judge");
});

test("the hash depends only on which findings exist, so the cron can dedup on it", () => {
  const info = (s) => ({ reason: s.status === "failed" ? "x" : null, obs: noObs });
  const one = buildInsights([run("a", { status: "failed" }), run("b", { status: "failed" })], { now: NOW, runInfo: info });
  const two = buildInsights([run("c", { status: "failed", hoursAgo: 2 }), run("d", { status: "failed" })], { now: NOW, runInfo: info });
  const none = buildInsights([run("e")], { now: NOW, runInfo: info });
  assert.equal(one.findingsHash, two.findingsHash);
  assert.notEqual(one.findingsHash, none.findingsHash);
});

test("doctor findings above low are carried over", () => {
  const r = buildInsights([], {
    now: NOW,
    runInfo: () => ({ reason: null, obs: noObs }),
    doctor: { counts: { high: 1 }, findings: [
      { kind: "grant_revoked", severity: "high", cli: "claude", detail: "grants revoked" },
      { kind: "harness_verification_unsupported", severity: "low", cli: "codex" },
    ] },
  });
  assert.deepEqual(r.findings.map((f) => f.id), ["doctor:grant_revoked:claude"]);
});
