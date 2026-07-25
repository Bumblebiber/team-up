import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateAvailability,
  chainCapacityReport,
} from "../../src/supervisor/capacity.mjs";

const roster = {
  limits: { handoff_at: 0.95, handoff_at_burst: 0.9 },
  models: {
    a: {
      tier: "frontier",
      cli: ["claude"],
      account: "claude",
      provider: "anthropic",
      limit_windows: ["claude:5h"],
      reasoning: { max: "max" },
    },
  },
};

test("candidate availability uses latest blocking reset", () => {
  const usage = {
    windows: {
      "claude:5h": {
        used: 0.96,
        resets_at: "2026-07-25T18:10:00.000Z",
        resets_at_raw: "Jul 25, 8:10pm (Europe/Berlin)",
        reset_confidence: "provider",
        updated_at: "2026-07-25T16:00:00Z",
      },
    },
  };
  const report = candidateAvailability({
    candidate: { cli: "claude", model: "a" },
    usage,
    roster,
    now: "2026-07-25T16:00:00Z",
  });
  assert.equal(report.available, false);
  assert.equal(report.available_at, "2026-07-25T18:10:00.000Z");
});

test("chain next_reset_at is earliest fully available candidate", () => {
  const usage = {
    windows: {
      "claude:5h": {
        used: 0.96,
        resets_at: "2026-07-25T18:10:00.000Z",
        reset_confidence: "provider",
        updated_at: "2026-07-25T16:00:00Z",
      },
    },
  };
  const report = chainCapacityReport({
    profileResult: {
      chain: [{ cli: "claude", model: "a" }],
    },
    usage,
    roster,
    now: "2026-07-25T16:00:00Z",
  });
  assert.equal(report.available_count, 0);
  assert.equal(report.next_reset_at, "2026-07-25T18:10:00.000Z");
});

test("preserves normalized reset_confidence from windows", () => {
  const usage = {
    windows: {
      "claude:5h": {
        used: 0.96,
        resets_at: "2026-07-25T18:10:00.000Z",
        reset_confidence: "parsed",
        updated_at: "2026-07-25T16:00:00Z",
      },
    },
  };
  const report = chainCapacityReport({
    profileResult: {
      chain: [],
      quota_blocked: [{ cli: "claude", model: "a" }],
    },
    usage,
    roster,
    now: "2026-07-25T16:00:00Z",
  });
  assert.equal(report.available_count, 0);
  assert.equal(report.next_reset_at, "2026-07-25T18:10:00.000Z");
  assert.equal(report.reset_confidence, "parsed");
});
