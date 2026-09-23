import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectStalledCollectors,
  detectExpiredHighUsage,
  detectUnexplainedUsageJumps,
  detectCollectFailures,
  detectMarkedEntries,
  runWatchdog,
} from "../../scripts/usage-watchdog.mjs";
import { DEFAULT_CONFIG } from "../../src/usage/usage-watcher.mjs";

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const ROSTER = { limits: { handoff_at: 0.95, handoff_at_burst: 0.8 } };

test("runWatchdog is silent when all detectors pass", () => {
  const result = runWatchdog({
    usage: {
      windows: {
        "claude:session": {
          used: 0.1,
          updated_at: "2026-09-23T11:58:00.000Z",
          history: [{ at: NOW - 120_000, used: 0.09 }, { at: NOW - 60_000, used: 0.1 }],
        },
      },
      marked: {},
    },
    watcher: {
      state: "idle",
      collecting: { claude: false, codex: false, cursor: false },
      last_collect: { claude: "2026-09-23T11:55:00.000Z" },
      next_due: { claude: "2026-09-23T12:05:00.000Z" },
      collect_failures: {},
    },
    roster: ROSTER,
    now: NOW,
    cfg: DEFAULT_CONFIG,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test("detectStalledCollectors flags overdue cli", () => {
  const issues = detectStalledCollectors({
    usage: { windows: { "codex:weekly": { used: 0.2, updated_at: "2026-09-23T10:00:00.000Z" } } },
    watcher: {
      state: "idle",
      collecting: { codex: false },
      last_collect: { codex: "2026-09-23T10:00:00.000Z" },
      next_due: { codex: "2026-09-23T10:05:00.000Z" },
    },
    now: NOW,
    cfg: DEFAULT_CONFIG,
  });
  assert.ok(issues.some((i) => i.includes("codex collector stalled")));
});

test("detectExpiredHighUsage flags window past reset still hot", () => {
  const issues = detectExpiredHighUsage({
    usage: {
      windows: {
        "claude:5h": { used: 0.99, resets_at: "2026-09-23T11:00:00.000Z" },
      },
    },
    roster: ROSTER,
    now: NOW,
  });
  assert.ok(issues.some((i) => i.includes("claude:5h")));
});

test("detectUnexplainedUsageJumps flags large delta", () => {
  const issues = detectUnexplainedUsageJumps({
    usage: {
      windows: {
        "claude:week": {
          used: 0.5,
          history: [{ at: 1, used: 0.2 }, { at: 2, used: 0.5 }],
        },
      },
    },
  });
  assert.ok(issues.some((i) => i.includes("20% → 50%")));
});

test("detectCollectFailures flags repeated failures and auth errors", () => {
  const issues = detectCollectFailures({
    watcher: {
      collect_failures: {
        codex: [
          { at: "t1", reason: "pty-lock-contention" },
          { at: "t2", reason: "pty-lock-contention" },
          { at: "t3", reason: "pty-lock-contention" },
        ],
        claude: [{ at: "t4", reason: "not logged in to Anthropic" }],
      },
    },
  });
  assert.ok(issues.some((i) => i.includes("pty-lock-contention")));
  assert.ok(issues.some((i) => i.includes("auth/login")));
});

test("detectMarkedEntries reports active and just-expired marks", () => {
  const issues = detectMarkedEntries({
    usage: {
      marked: {
        active: { until: "2026-09-23T13:00:00.000Z" },
        expired: { until: "2026-09-23T11:30:00.000Z" },
      },
    },
    now: NOW,
  });
  assert.ok(issues.some((i) => i.includes("active until")));
  assert.ok(issues.some((i) => i.includes("expired")));
});
