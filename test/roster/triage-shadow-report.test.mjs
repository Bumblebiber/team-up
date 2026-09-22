import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTriageShadowReport,
  buildTriageVerdictReport,
  isBadOutcome,
} from "../../scripts/triage-shadow-report.mjs";

test("shadow report compares proposed tiers with actual worker outcomes by role", () => {
  const states = [
    {
      role: "implementer", status: "failed", worker: { tier: "frontier" },
      triage: { source: "jev", applied: false, profile: { tier: "high" } },
    },
    {
      role: "implementer", status: "done", worker: { tier: "low" },
      escalations: [{ kind: "handoff" }],
      triage: { source: "jev", applied: false, profile: { tier: "medium" } },
    },
    {
      role: "implementer", status: "done", worker: { tier: "medium" },
      triage: { source: "fallback", applied: false, profile: null },
    },
    {
      role: "implementer", status: "failed", worker: { tier: "low" },
      triage: { source: "jev", applied: true, profile: { tier: "high" } },
    },
    {
      role: "researcher", status: "waiting_human", worker: {},
      triage: { source: "jev", applied: false, profile: { tier: "frontier" } },
    },
  ];
  const { roles } = buildTriageShadowReport(states);
  assert.deepEqual(roles.implementer, {
    runs: 3, jev: 2, fallback: 1,
    wouldDowngrade: 1, wouldUpgrade: 1, sameTier: 0, unknownWorkerTier: 0,
    highTier: { runs: 1, done: 0, failed: 1, escalated: 0 },
    lowerTier: { runs: 1, done: 1, failed: 0, escalated: 1 },
  });
  assert.equal(roles.researcher.unknownWorkerTier, 1);
  assert.equal(roles.researcher.highTier.escalated, 1);
});

test("isBadOutcome uses status failed, waiting_human, and escalations", () => {
  assert.equal(isBadOutcome({ status: "failed" }), true);
  assert.equal(isBadOutcome({ status: "waiting_human" }), true);
  assert.equal(isBadOutcome({ status: "done", escalations: [{ kind: "pass-to" }] }), true);
  assert.equal(isBadOutcome({ status: "done" }), false);
});

function shadowState(tier, status = "done", extra = {}) {
  return {
    status,
    triage: { source: "jev", applied: false, profile: { tier } },
    ...extra,
  };
}

test("verdict COLLECTING when total below min-runs", () => {
  const states = Array.from({ length: 5 }, (_, i) =>
    shadowState(i % 2 === 0 ? "high" : "low"),
  );
  const report = buildTriageVerdictReport(states, { minRuns: 50, minGroup: 1 });
  assert.equal(report.shadow.verdict, "COLLECTING");
});

test("verdict COLLECTING when either group below min-group", () => {
  const states = [
    ...Array.from({ length: 20 }, () => shadowState("high")),
    ...Array.from({ length: 5 }, () => shadowState("low")),
  ];
  const report = buildTriageVerdictReport(states, { minRuns: 10, minGroup: 10 });
  assert.equal(report.shadow.verdict, "COLLECTING");
});

test("verdict DECISION_DUE when high bad-rate exceeds low by min-diff", () => {
  const states = [
    ...Array.from({ length: 10 }, () => shadowState("high", "failed")),
    ...Array.from({ length: 10 }, () => shadowState("low", "done")),
  ];
  const report = buildTriageVerdictReport(states, { minRuns: 20, minGroup: 10, minDiff: 0.10 });
  assert.equal(report.shadow.verdict, "DECISION_DUE");
  assert.equal(report.shadow.diff, 1);
});

test("verdict STOP when enough data and no signal", () => {
  const states = [
    ...Array.from({ length: 10 }, () => shadowState("high", "done")),
    ...Array.from({ length: 10 }, () => shadowState("low", "done")),
  ];
  const report = buildTriageVerdictReport(states, { minRuns: 20, minGroup: 10, minDiff: 0.10 });
  assert.equal(report.shadow.verdict, "STOP");
  assert.equal(report.shadow.diff, 0);
});

test("active REGRESSION when applied bad-rate exceeds control", () => {
  const states = [
    ...Array.from({ length: 10 }, () => ({
      status: "failed",
      triage: { source: "jev", applied: true, profile: { tier: "high" } },
    })),
    ...Array.from({ length: 10 }, () => shadowState("low", "done")),
  ];
  const report = buildTriageVerdictReport(states, { minRuns: 10, minGroup: 10, minDiff: 0.10 });
  assert.equal(report.active.verdict, "REGRESSION");
});

test("active OK when both groups large enough and no regression", () => {
  const states = [
    ...Array.from({ length: 10 }, () => ({
      status: "done",
      triage: { source: "jev", applied: true, profile: { tier: "high" } },
    })),
    ...Array.from({ length: 10 }, () => shadowState("low", "done")),
  ];
  const report = buildTriageVerdictReport(states, { minRuns: 10, minGroup: 10, minDiff: 0.10 });
  assert.equal(report.active.verdict, "OK");
});

test("active INSUFFICIENT when either group below min-group", () => {
  const states = [
    {
      status: "done",
      triage: { source: "jev", applied: true, profile: { tier: "high" } },
    },
    shadowState("low", "done"),
  ];
  const report = buildTriageVerdictReport(states, { minRuns: 2, minGroup: 10 });
  assert.equal(report.active.verdict, "INSUFFICIENT");
});

test("fallback_reason counts are aggregated", () => {
  const states = [
    { triage: { fallback_reason: "no_key" } },
    { triage: { fallback_reason: "no_key" } },
    { triage: { fallback_reason: "timeout" } },
  ];
  const report = buildTriageVerdictReport(states);
  assert.deepEqual(report.fallback_reasons, { no_key: 2, timeout: 1 });
});

test("JSON report shape is stable", () => {
  const report = buildTriageVerdictReport([
    shadowState("high", "failed"),
    shadowState("low", "done"),
  ]);
  assert.ok(report.generated_at);
  assert.ok(["COLLECTING", "DECISION_DUE", "STOP"].includes(report.shadow.verdict));
  assert.ok(report.shadow.groups.high);
  assert.ok(report.shadow.groups.low);
  assert.ok(["REGRESSION", "OK", "INSUFFICIENT"].includes(report.active.verdict));
  assert.ok(report.active.applied);
  assert.ok(report.active.control);
  assert.ok(report.per_role);
});
