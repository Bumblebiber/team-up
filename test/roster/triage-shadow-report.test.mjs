import test from "node:test";
import assert from "node:assert/strict";
import { buildTriageShadowReport } from "../../scripts/triage-shadow-report.mjs";

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
