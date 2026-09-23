import { test } from "node:test";
import assert from "node:assert/strict";
import {
  joinTmuxSessions,
  buildUsageView,
  buildPickAllView,
  buildModelsView,
  sanitizeForDashboard,
  isValidRunId,
  usageStaleThresholdMs,
} from "../../src/dashboard/data.mjs";

const NOW = Date.parse("2026-09-22T12:00:00Z");

const ROSTER = {
  clis: {
    claude: { cmd: ["claude", "--model", "{model}", "{prompt}"] },
    codex: { cmd: ["codex", "--model", "{model}", "{prompt}"] },
  },
  models: {
    "model-a": { provider: "anthropic", tier: "frontier", cli: ["claude"] },
    "model-b": { provider: "openai", tier: "high", cli: ["codex"] },
    "model-c": {
      provider: "deepseek",
      tier: "mid",
      cli: ["codex"],
      account: "secret-acct",
    },
  },
  roles: {
    planner: { chain: ["model-a", "model-b"] },
    implementer: { chain: ["model-c", "model-a"] },
  },
  limits: { warn_at: 0.9, handoff_at: 0.95 },
  accounts: {
    "secret-acct": {
      kind: "credit",
      enabled: false,
      remaining: 0,
      api_key: "FAKE-SECRET-should-never-appear",
    },
  },
  usage_watcher: { intervals: { active_min: 15 } },
};

test("isValidRunId matches createRun format", () => {
  assert.ok(isValidRunId("20260922T100319Z-ri6m"));
  assert.ok(!isValidRunId("../evil"));
  assert.ok(!isValidRunId("not-a-run"));
});

test("joinTmuxSessions links sessions to runs and flags orphans", () => {
  const sessions = ["team-up-worker-1", "team-up-orphan", "other-session"];
  const states = [
    {
      runId: "20260922T100319Z-ri6m",
      status: "watching",
      role: "implementer",
      worker: { tmux: "team-up-worker-1" },
    },
    {
      runId: "20260922T110000Z-abcd",
      status: "done",
      role: "planner",
      worker: { tmux: "team-up-done" },
    },
  ];
  const { sessions: joined, orphans } = joinTmuxSessions(sessions, states);
  assert.equal(joined.length, 3);
  const linked = joined.find((s) => s.session === "team-up-worker-1");
  assert.equal(linked.runId, "20260922T100319Z-ri6m");
  assert.equal(linked.orphan, false);
  const orphan = joined.find((s) => s.session === "team-up-orphan");
  assert.equal(orphan.orphan, true);
  assert.equal(orphan.runId, null);
  assert.equal(orphans.length, 2);
});

test("usage view classifies red, amber, and stale", () => {
  const usage = {
    windows: {
      "claude:session": {
        used: 0.96,
        resets_at: "2026-09-22T18:00:00Z",
        updated_at: "2026-09-22T11:50:00Z",
      },
      "codex:5h": {
        used: 0.91,
        resets_at: "2026-09-22T14:00:00Z",
        updated_at: "2026-09-22T11:55:00Z",
      },
      "cursor:included": {
        used: 0.2,
        resets_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-09-20T12:00:00Z",
      },
    },
    marked: {
      "model-a": { until: "2026-09-23T00:00:00Z", reason: "test" },
      expired: { until: "2026-09-21T00:00:00Z" },
    },
  };
  const view = buildUsageView(usage, ROSTER, NOW);
  assert.equal(view.windows["claude:session"].level, "red");
  assert.equal(view.windows["codex:5h"].level, "amber");
  assert.equal(view.windows["cursor:included"].level, "ok");
  assert.equal(view.windows["cursor:included"].stale, true);
  assert.equal(view.marked.length, 1);
  assert.equal(view.marked[0].key, "model-a");
});

test("usage stale threshold defaults to 40 min, doubles active_min when set", () => {
  assert.equal(usageStaleThresholdMs({}), 40 * 60_000);
  assert.equal(usageStaleThresholdMs(ROSTER), 2 * 15 * 60_000);
});

test("pick-all over fake roster includes skipped reasons", () => {
  const usage = {
    windows: { "claude:session": { used: 0.5, updated_at: "2026-09-22T11:00:00Z" } },
    providers: { anthropic: { used: 0.5 } },
  };
  const view = buildPickAllView(ROSTER, usage, NOW);
  assert.equal(view.picks.length, 2);
  const impl = view.picks.find((p) => p.role === "implementer");
  assert.equal(impl.model, "model-a");
  assert.ok(impl.skipped.some((s) => s.reason === "account disabled"));
  const json = JSON.stringify(view);
  assert.ok(!json.includes("FAKE-SECRET-should-never-appear"));
  assert.ok(!json.includes("api_key"));
  assert.ok(!json.includes("secret-acct"));
});

test("buildModelsView joins scores with roster and proposals", () => {
  const scoresFile = {
    models: {
      "model-a": {
        display_name: "A",
        provider: "anthropic",
        scores: { coding_index: 90 },
        price: { in: 1, out: 2 },
      },
      "new-hot": {
        display_name: "New",
        provider: "xai",
        openrouter_id: "x-ai/new-hot",
        scores: { coding_index: 99 },
      },
    },
  };
  const roster = {
    ...ROSTER,
    roles: { planner: { chain: ["model-a"] } },
    scores: { min_delta: 2 },
  };
  const view = buildModelsView(scoresFile, roster);
  assert.equal(view.total, 2);
  const hot = view.models.find((m) => m.model === "new-hot");
  assert.ok(hot?.proposal);
  const inRoster = buildModelsView(scoresFile, roster, { in_roster: true });
  assert.equal(inRoster.total, 1);
});

test("sanitizeForDashboard strips secret-looking keys", () => {
  const raw = {
    name: "ok",
    api_key: "hidden",
    nested: { access_token: "nope", fine: "yes" },
    accounts: { x: { password: "p" } },
  };
  const clean = sanitizeForDashboard(raw, { stripAccounts: true });
  assert.deepEqual(clean, { name: "ok", nested: { fine: "yes" } });
});
