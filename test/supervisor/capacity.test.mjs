import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateAvailability,
  chainCapacityReport,
} from "../../src/supervisor/capacity.mjs";
import { resolveLimitWindowsForCell } from "../../src/supervisor/start.mjs";
import { usedFraction } from "../../src/supervisor/production.mjs";
import { decideTransition } from "../../src/supervisor/controller.mjs";
import { resolveProfile } from "../../src/roster/profile.mjs";

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

// A cursor model with no declared limit_windows is gated on cursor:included,
// the window its CLI implies (resolveLimitWindows, as in pick and
// resolveProfile). The capacity report and the started run's runtime read
// only the declared list: the controller waited forever on a report that
// called the cell available, and recheck-capacity started it while exhausted.
const gated = {
  accounts: {
    codex: { kind: "subscription", enabled: true },
    cursor: { kind: "subscription", enabled: true },
  },
  clis: {
    codex: { cmd: ["codex", "--model", "{model}", "{prompt}"] },
    cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] },
  },
  models: {
    sol: { cli: ["codex"], account: "codex", limit_windows: ["codex:weekly"] },
    grok: { cli: ["cursor"], account: "cursor" },
  },
  roles: { reviewer: { chain: ["codex:sol", "cursor:grok"] } },
  specialists: { "review.revan": { role: "reviewer" } },
};

test("the capacity report blocks a cell on the windows its CLI implies, as the profile does", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  const updated_at = "2026-10-03T11:55:00Z";
  const usage = {
    windows: {
      "codex:weekly": { used: 1, resets_at: "2026-10-04T12:00:00.000Z", updated_at },
      "cursor:included": { used: 1, resets_at: "2026-10-06T12:00:00.000Z", updated_at },
    },
  };
  const profileResult = resolveProfile({ roster: gated, specialistId: "review.revan", usage, now });
  assert.deepEqual(profileResult.quota_blocked.map((c) => c.model), ["sol", "grok"]);

  const report = chainCapacityReport({ profileResult, usage, roster: gated, now });
  assert.equal(report.available_count, 0);
  const grok = report.blocked_candidates.find((r) => r.candidate.model === "grok");
  assert.deepEqual(grok.blocking_windows, ["cursor:included"]);
  assert.equal(grok.available_at, "2026-10-06T12:00:00.000Z");
  assert.equal(report.next_reset_at, "2026-10-04T12:00:00.000Z");
});

// The runtime keeps the declared windows only. In-run supervision hands off
// at prepare_at 0.9 while the start gate blocks at 0.95, and the successor
// shares the derived window, so supervising it looped between cursor cells.
test("a started cell's runtime watches only the windows its model declares", () => {
  assert.deepEqual(resolveLimitWindowsForCell({ cli: "cursor", model: "grok" }, gated), []);
  assert.deepEqual(resolveLimitWindowsForCell({ cli: "codex", model: "sol" }, gated), ["codex:weekly"]);
});

test("cursor cells between prepare_at and the start gate hand off to no one", () => {
  const designer = {
    accounts: gated.accounts,
    clis: gated.clis,
    models: {
      "composer-2.5": { cli: ["cursor"], account: "cursor" },
      "grok-4.7": { cli: ["cursor"], account: "cursor" },
      "gpt-6-luna": { cli: ["codex"], account: "codex", limit_windows: ["codex:weekly"] },
    },
    roles: { designer: { chain: ["cursor:composer-2.5", "cursor:grok-4.7", "codex:gpt-6-luna"] } },
    specialists: { "frontend.designer": { role: "designer" } },
  };
  const now = Date.parse("2026-10-03T12:00:00Z");
  const updated_at = "2026-10-03T11:55:00Z";
  const usage = {
    windows: {
      "cursor:included": { used: 0.92, resets_at: "2026-10-27T00:00:00.000Z", updated_at },
      "codex:weekly": { used: 0.1, resets_at: "2026-10-04T12:00:00.000Z", updated_at },
    },
  };
  const profile = resolveProfile({ roster: designer, specialistId: "frontend.designer", usage, now });
  assert.deepEqual(profile.chain.map((c) => c.model), ["composer-2.5", "grok-4.7", "gpt-6-luna"]);
  for (const cell of profile.chain.filter((c) => c.cli === "cursor")) {
    const runtime = { ...cell, limit_windows: resolveLimitWindowsForCell(cell, designer) };
    const used = usedFraction({ runtime }, usage);
    assert.equal(decideTransition({ state: "running", used }).action, "noop", cell.model);
  }
});
