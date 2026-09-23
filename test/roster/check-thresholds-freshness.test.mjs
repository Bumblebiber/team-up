import { test } from "node:test";
import assert from "node:assert/strict";
import { checkThresholds, checkThresholdsWithRefresh, limits } from "../../src/roster/chain.mjs";

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const ROSTER = { limits: { warn_at: 0.9, handoff_at: 0.95, usage_max_age_min: 10 } };

test("limits defaults usage_max_age_min to 10", () => {
  assert.equal(limits({}).usage_max_age_min, 10);
});

test("checkThresholds warns from stale data but does not block", () => {
  const out = checkThresholds({
    roster: ROSTER,
    usage: {
      windows: {
        "claude:week": {
          used: 0.92,
          updated_at: "2026-09-23T10:00:00.000Z",
        },
      },
    },
    now: NOW,
  });
  assert.match(out.message, /claude:week at 92%/);
  assert.deepEqual(out.needsRefresh, []);
});

test("checkThresholds requests refresh instead of blocking on stale hot window", () => {
  const out = checkThresholds({
    roster: ROSTER,
    usage: {
      windows: {
        "claude:5h": {
          used: 0.97,
          updated_at: "2026-09-23T10:00:00.000Z",
        },
      },
    },
    now: NOW,
  });
  assert.equal(out.message, "");
  assert.deepEqual(out.needsRefresh, ["claude"]);
});

test("checkThresholds blocks on fresh hot window", () => {
  const out = checkThresholds({
    roster: ROSTER,
    usage: {
      windows: {
        "claude:5h": {
          used: 0.97,
          updated_at: "2026-09-23T11:55:00.000Z",
        },
      },
    },
    now: NOW,
  });
  assert.match(out.message, /session limit reached/);
  assert.deepEqual(out.needsRefresh, []);
});

test("checkThresholds ignores expired resets", () => {
  const out = checkThresholds({
    roster: ROSTER,
    usage: {
      windows: {
        "codex:weekly": { used: 1.0, resets_at: "2026-09-23T11:00:00.000Z" },
      },
    },
    now: NOW,
  });
  assert.equal(out.message, "");
});

test("checkThresholdsWithRefresh collects stale cli then re-evaluates", async () => {
  let collected = [];
  const out = await checkThresholdsWithRefresh({
    roster: ROSTER,
    usage: {
      windows: {
        "codex:5h": { used: 0.99, updated_at: "2026-09-23T10:00:00.000Z" },
      },
    },
    now: NOW,
    collectCli: async (cli) => {
      collected.push(cli);
      return { ok: true };
    },
    readUsage: () => ({
      windows: {
        "codex:5h": { used: 0.2, updated_at: "2026-09-23T11:59:00.000Z" },
      },
    }),
  });
  assert.deepEqual(collected, ["codex"]);
  assert.equal(out.message, "");
  assert.deepEqual(out.needsRefresh, []);
});
