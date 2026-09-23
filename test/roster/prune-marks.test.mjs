import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneExpiredMarks } from "../../src/roster/chain.mjs";

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const HOUR = 60 * 60_000;

test("pruneExpiredMarks keeps active and recently expired marks", () => {
  const usage = {
    marked: {
      active: { until: new Date(NOW + HOUR).toISOString() },
      "just-expired": { until: new Date(NOW - 2 * HOUR).toISOString() },
    },
  };
  const out = pruneExpiredMarks({ usage, now: NOW });
  assert.deepEqual(out.pruned, []);
  assert.equal(out.usage, usage);
});

test("pruneExpiredMarks drops marks past the grace window", () => {
  const usage = {
    windows: { "claude:5h": { used: 0.1 } },
    marked: {
      active: { until: new Date(NOW + HOUR).toISOString() },
      stale: { until: new Date(NOW - 48 * HOUR).toISOString(), reason: "402" },
    },
  };
  const out = pruneExpiredMarks({ usage, now: NOW });
  assert.deepEqual(out.pruned, ["stale"]);
  assert.deepEqual(Object.keys(out.usage.marked), ["active"]);
  assert.deepEqual(out.usage.windows, usage.windows);
  assert.ok(usage.marked.stale, "input is not mutated");
});

test("pruneExpiredMarks ignores unparsable and missing marks", () => {
  assert.deepEqual(pruneExpiredMarks({ usage: null, now: NOW }).pruned, []);
  const usage = { marked: { weird: { until: "not a date" } } };
  const out = pruneExpiredMarks({ usage, now: NOW });
  assert.deepEqual(out.pruned, []);
  assert.ok(out.usage.marked.weird);
});
