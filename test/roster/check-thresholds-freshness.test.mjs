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

test("checkThresholds blocks stale hot window with staleness marker", () => {
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
  assert.match(out.message, /session limit reached/);
  assert.match(out.message, /120 min old/);
  assert.match(out.message, /team-up usage --refresh/);
  assert.deepEqual(out.needsRefresh, ["claude"]);
});

test("checkThresholds blocks on fresh hot window without staleness marker", () => {
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
  assert.doesNotMatch(out.message, /min old/);
  assert.deepEqual(out.needsRefresh, []);
});

test("checkThresholds uses per-window freshness not sibling windows", () => {
  const out = checkThresholds({
    roster: ROSTER,
    usage: {
      windows: {
        "codex:weekly": { used: 0.1, updated_at: "2026-09-23T11:59:00.000Z" },
        "codex:5h": { used: 0.99, updated_at: "2026-09-23T10:00:00.000Z" },
      },
    },
    now: NOW,
  });
  assert.match(out.message, /codex:5h at 99%/);
  assert.match(out.message, /min old/);
  assert.deepEqual(out.needsRefresh, ["codex"]);
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

test("checkThresholdsWithRefresh schedules refresh but keeps stale block", async () => {
  let collected = [];
  const out = await checkThresholdsWithRefresh({
    roster: ROSTER,
    usage: {
      windows: {
        "codex:5h": { used: 0.99, updated_at: "2026-09-23T10:00:00.000Z" },
      },
    },
    now: NOW,
    scheduleRefresh: (cli) => {
      collected.push(cli);
    },
  });
  assert.deepEqual(collected, ["codex"]);
  assert.match(out.message, /session limit reached/);
  assert.match(out.message, /min old/);
});

test("checkThresholdsWithRefresh keeps block when refresh fails", async () => {
  const out = await checkThresholdsWithRefresh({
    roster: ROSTER,
    usage: {
      windows: {
        "codex:weekly": { used: 0.97, updated_at: "2026-09-23T10:00:00.000Z" },
      },
    },
    now: NOW,
    scheduleRefresh: () => {},
    collectCli: async () => ({ ok: false, reason: "pty-lock-contention" }),
  });
  assert.match(out.message, /codex:weekly at 97%/);
  assert.match(out.message, /session limit reached/);
});

test("checkThresholdsWithRefresh keeps block when refresh returns unchanged usage", async () => {
  const usage = {
    windows: {
      "codex:5h": { used: 0.99, updated_at: "2026-09-23T10:00:00.000Z" },
    },
  };
  const out = await checkThresholdsWithRefresh({
    roster: ROSTER,
    usage,
    now: NOW,
    scheduleRefresh: () => {},
    collectCli: async () => ({ ok: true }),
  });
  assert.match(out.message, /codex:5h at 99%/);
  assert.match(out.message, /session limit reached/);
});
