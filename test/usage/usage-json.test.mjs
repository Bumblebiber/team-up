import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectUsageForCli, mergeUsageWindows } from "../../src/usage/usage-collect.mjs";
import { fetchAgyUsageJson, fetchClaudeUsageJson, fetchCodexUsageJson, parseAgyUsage } from "../../src/usage/usage-json.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/usage");
const NOW = Date.parse("2026-10-09T08:13:46.000Z");
const UPDATED = new Date(NOW).toISOString();
const TOKEN = "usage-json-token-must-never-escape-71fb";
const MODE_0600 = 0o600;

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

function credentialReader(value, mode = MODE_0600) {
  return (filePath) => ({ content: JSON.stringify(value), mode, filePath });
}

function jsonResponse(body, status = 200) {
  return { status, json: async () => body };
}

const claudeCredentials = {
  claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW + 60_000 },
};
const codexCredentials = {
  tokens: { access_token: TOKEN, account_id: "acct-fixture-123" },
};

test("Claude JSON collector maps OAuth limits into shared records", async () => {
  let request;
  const result = await fetchClaudeUsageJson({
    env: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
    homeDir: "/unused-home",
    fileReader: credentialReader(claudeCredentials),
    fetchImpl: async (...args) => {
      request = args;
      return jsonResponse(fixture("claude-oauth-usage.json"));
    },
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.windows).sort(), ["claude:fable-week", "claude:session", "claude:week"]);
  assert.equal(request[0], "https://api.anthropic.com/api/oauth/usage");
  assert.deepEqual(request[1].headers, {
    Authorization: `Bearer ${TOKEN}`,
    "anthropic-beta": "oauth-2025-04-20",
    Accept: "application/json",
    "User-Agent": "claude-code/2.1.0",
  });
  assert.ok(request[1].signal);

  const expected = {
    "claude:session": [0.02, "2026-10-09T12:10:00.436Z"],
    "claude:week": [0.11, "2026-10-12T08:00:00.436Z"],
    "claude:fable-week": [0, "2026-10-12T08:00:00.000Z"],
  };
  for (const [key, [used, resetsAt]] of Object.entries(expected)) {
    const record = result.windows[key];
    assert.equal(record.window, key.slice("claude:".length));
    assert.equal(record.used, used);
    assert.equal(record.resets_at, resetsAt);
    assert.equal(record.resets_at_raw, null);
    assert.equal(record.reset_confidence, "provider");
    assert.equal(record.updated_at, UPDATED);
    assert.equal(record.source, "claude:oauth-usage-api");
  }
  assert.equal(result.windows["claude:fable-week"].scope, "fable");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("Claude JSON collector falls back to legacy keys when limits is absent", async () => {
  const body = fixture("claude-oauth-usage.json");
  delete body.limits;
  const result = await fetchClaudeUsageJson({
    env: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
    fileReader: credentialReader(claudeCredentials),
    fetchImpl: async () => jsonResponse(body),
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.windows).sort(), ["claude:session", "claude:week"]);
  assert.equal(result.windows["claude:session"].used, 0.02);
  assert.equal(result.windows["claude:session"].resets_at, "2026-10-09T12:10:00.436Z");
  assert.equal(result.windows["claude:week"].used, 0.11);
  assert.equal(result.windows["claude:week"].resets_at, "2026-10-12T08:00:00.436Z");
});

test("Claude JSON collector ignores unknown and surface-scoped limits", async () => {
  const result = await fetchClaudeUsageJson({
    env: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
    fileReader: credentialReader(claudeCredentials),
    fetchImpl: async () => jsonResponse({
      limits: [
        { kind: "session", percent: 10, resets_at: "2026-10-09T12:00:00Z" },
        { kind: "weekly_all", percent: 20, resets_at: "2026-10-12T08:00:00Z" },
        { kind: "weekly_scoped", percent: 90, resets_at: "2026-10-12T08:00:00Z", scope: { model: { display_name: "Fable" }, surface: "web" } },
        { kind: "monthly", percent: 90, resets_at: "2026-10-12T08:00:00Z" },
      ],
    }),
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.windows).sort(), ["claude:session", "claude:week"]);
});

test("expired Claude token and unsafe credential mode refuse request", async () => {
  let requests = 0;
  const expired = await fetchClaudeUsageJson({
    env: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
    fileReader: credentialReader({ claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW } }),
    fetchImpl: async () => { requests += 1; return jsonResponse({}); },
    now: NOW,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "Claude OAuth token expired");
  assert.equal(requests, 0);

  const unsafe = await fetchClaudeUsageJson({
    env: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
    fileReader: credentialReader(claudeCredentials, 0o644),
    fetchImpl: async () => { requests += 1; return jsonResponse({}); },
    now: NOW,
  });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.reason, "credential file is group- or world-readable");
  assert.equal(requests, 0);
});

test("Codex JSON collector maps standard and scoped WHAM windows", async () => {
  let request;
  const result = await fetchCodexUsageJson({
    env: { CODEX_HOME: "/fixture/codex" },
    homeDir: "/unused-home",
    fileReader: credentialReader(codexCredentials),
    fetchImpl: async (...args) => {
      request = args;
      return jsonResponse(fixture("codex-wham-usage.json"));
    },
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.windows).sort(), ["codex:5h", "codex:luna-reserve-weekly", "codex:weekly"]);
  assert.equal(request[0], "https://chatgpt.com/backend-api/wham/usage");
  assert.deepEqual(request[1].headers, {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/json",
    "User-Agent": "codex-cli",
    "ChatGPT-Account-ID": "acct-fixture-123",
  });
  assert.ok(request[1].signal);

  const expected = {
    "codex:5h": [0, "2026-10-09T13:13:11.000Z"],
    "codex:weekly": [0.01, "2026-10-14T09:29:04.000Z"],
    "codex:luna-reserve-weekly": [0, "2026-10-16T08:13:11.000Z"],
  };
  for (const [key, [used, resetsAt]] of Object.entries(expected)) {
    const record = result.windows[key];
    assert.equal(record.window, key.slice("codex:".length));
    assert.equal(record.used, used);
    assert.equal(record.resets_at, resetsAt);
    assert.equal(record.resets_at_raw, null);
    assert.equal(record.reset_confidence, "provider");
    assert.equal(record.updated_at, UPDATED);
    assert.equal(record.source, "codex:wham-usage-api");
  }
  assert.equal(result.windows["codex:luna-reserve-weekly"].scope, "gpt-5.6-luna");
});

test("Codex omits account header when auth has no account id and skips other durations", async () => {
  const result = await fetchCodexUsageJson({
    env: { CODEX_HOME: "/fixture/codex" },
    fileReader: credentialReader({ tokens: { access_token: TOKEN } }),
    fetchImpl: async (_url, options) => {
      assert.equal(Object.hasOwn(options.headers, "ChatGPT-Account-ID"), false);
      return jsonResponse({
        rate_limit: {
          primary_window: { used_percent: 50, limit_window_seconds: 18_000, reset_at: 1_791_551_591 },
          secondary_window: { used_percent: 5, limit_window_seconds: 604_800, reset_at: 1_791_970_144 },
        },
        additional_rate_limits: [{
          limit_name: "gpt-reserve",
          normal_model_slug: "gpt-5.6-luna",
          rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 3600, reset_at: 1_791_551_591 } },
        }],
      });
    },
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.windows).sort(), ["codex:5h", "codex:weekly"]);
});

test("JSON source failures fall back and preserve safe reasons", async () => {
  let fallbackCalls = 0;
  const options = {
    roster: { subscriptions: ["claude"] },
    cli: "claude",
    dryRun: true,
    env: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
    fileReader: credentialReader({ claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW } }),
    fetchImpl: async () => { throw new Error(TOKEN); },
    now: NOW,
    collectFallback: async () => {
      fallbackCalls += 1;
      return { "claude:session": { used: 0.2 } };
    },
  };
  const expired = await collectUsageForCli(options);
  assert.equal(expired.ok, true);
  assert.match(expired.reason, /Claude OAuth token expired/);
  assert.equal(fallbackCalls, 1);
  assert.equal(JSON.stringify(expired).includes(TOKEN), false);

  const unauthorized = await collectUsageForCli({
    ...options,
    fileReader: credentialReader(claudeCredentials),
    fetchImpl: async () => jsonResponse({}, 401),
  });
  assert.equal(unauthorized.ok, true);
  assert.match(unauthorized.reason, /HTTP 401/);
  assert.equal(fallbackCalls, 2);
  assert.equal(JSON.stringify(unauthorized).includes(TOKEN), false);

  const missing = await collectUsageForCli({
    ...options,
    fileReader: () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; },
  });
  assert.equal(missing.ok, true);
  assert.match(missing.reason, /credential file missing/);
  assert.equal(fallbackCalls, 3);
});

test("token never enters returned results or written usage document", async () => {
  let written;
  const result = await collectUsageForCli({
    roster: { subscriptions: ["claude"] },
    cli: "claude",
    env: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
    fileReader: credentialReader(claudeCredentials),
    fetchImpl: async () => jsonResponse(fixture("claude-oauth-usage.json")),
    now: NOW,
    readUsage: () => ({ windows: {}, marked: {} }),
    writeUsage: (document) => { written = JSON.stringify(document); },
    collectFallback: async () => assert.fail("successful JSON collection must not use PTY fallback"),
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(written.includes(TOKEN), false);

  const failedRequest = await fetchClaudeUsageJson({
    env: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
    fileReader: credentialReader(claudeCredentials),
    fetchImpl: async () => { throw new Error(TOKEN); },
    now: NOW,
  });
  assert.equal(JSON.stringify(failedRequest).includes(TOKEN), false);
  assert.doesNotReject(fetchClaudeUsageJson({
    env: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
    fileReader: credentialReader(claudeCredentials),
    fetchImpl: async () => { throw new Error(TOKEN); },
    now: NOW,
  }));
});

test("an overage reading is clamped to 100 % instead of dropped", async () => {
  const result = await fetchClaudeUsageJson({
    env: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
    fileReader: credentialReader(claudeCredentials),
    fetchImpl: async () => jsonResponse({
      limits: [
        { kind: "session", percent: 30, resets_at: "2026-10-09T12:00:00Z" },
        { kind: "weekly_all", percent: 101, resets_at: "2026-10-12T08:00:00Z" },
      ],
    }),
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.windows["claude:week"].used, 1);
});

test("a response missing a base window falls back to the PTY path with both reasons", async () => {
  const body = fixture("codex-wham-usage.json");
  body.rate_limit.secondary_window.limit_window_seconds = 604_799;
  const result = await collectUsageForCli({
    roster: { subscriptions: ["codex"] },
    cli: "codex",
    dryRun: true,
    env: { CODEX_HOME: "/fixture/codex" },
    fileReader: credentialReader(codexCredentials),
    fetchImpl: async () => jsonResponse(body),
    now: NOW,
    collectFallback: async () => { throw new Error("PTY_TIMEOUT codex: tail <pane>"); },
    loggedOut: () => false,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /lacked the 5h or weekly window/);
  assert.match(result.reason, /PTY fallback failed: PTY_TIMEOUT codex: tail <pane>/);
});

test("a record without scope keeps the scope the JSON source recorded", () => {
  const existing = { windows: { "codex:luna-reserve-weekly": { used: 0.1, scope: "gpt-5.6-luna" } }, marked: {} };
  const merged = mergeUsageWindows(existing, { "codex:luna-reserve-weekly": { used: 0.2, source: "codex:/status" } });
  assert.equal(merged.windows["codex:luna-reserve-weekly"].scope, "gpt-5.6-luna");
  assert.equal(merged.windows["codex:luna-reserve-weekly"].used, 0.2);
});

test("a window without a reset keeps its reading with an unknown reset", async () => {
  const result = await fetchClaudeUsageJson({
    env: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
    fileReader: credentialReader(claudeCredentials),
    fetchImpl: async () => jsonResponse({
      limits: [
        { kind: "session", percent: 0, resets_at: null },
        { kind: "weekly_all", percent: 40, resets_at: "2026-10-12T08:00:00Z" },
      ],
    }),
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.windows["claude:session"].used, 0);
  assert.equal(result.windows["claude:session"].resets_at, null);
  assert.equal(result.windows["claude:session"].reset_confidence, "unknown");
});

test("an unusable 5h window falls back instead of leaving the previous value", async () => {
  const body = fixture("codex-wham-usage.json");
  body.rate_limit.primary_window.limit_window_seconds = 18_001;
  const result = await fetchCodexUsageJson({
    env: { CODEX_HOME: "/fixture/codex" },
    fileReader: credentialReader(codexCredentials),
    fetchImpl: async () => jsonResponse(body),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /lacked the 5h or weekly window/);
});

test("an unusable Claude session window falls back", async () => {
  const result = await fetchClaudeUsageJson({
    env: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
    fileReader: credentialReader(claudeCredentials),
    fetchImpl: async () => jsonResponse({
      limits: [
        { kind: "session", percent: null, resets_at: "2026-10-09T12:00:00Z" },
        { kind: "weekly_all", percent: 40, resets_at: "2026-10-12T08:00:00Z" },
      ],
    }),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /lacked the session or week window/);
});

test("agy /usage maps all four quota buckets and runs prompt immediately after -p", () => {
  let call;
  const result = fetchAgyUsageJson({
    run: (bin, args, options) => {
      call = { bin, args, options };
      return JSON.stringify(fixture("agy-usage.json"));
    },
    env: { PATH: "/fixture/bin" },
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.windows).sort(), [
    "agy:3p-5h", "agy:3p-weekly", "agy:gemini-5h", "agy:gemini-weekly",
  ]);
  assert.deepEqual(call.bin, "agy");
  assert.deepEqual(call.args, ["-p", "/usage", "--output-format", "json"]);
  assert.equal(call.options.env.PATH, "/fixture/bin");
  assert.equal(result.windows["agy:gemini-weekly"].used, 0.25);
  assert.equal(result.windows["agy:gemini-weekly"].resets_at, "2026-10-16T12:52:05.000Z");
  assert.equal(result.windows["agy:gemini-5h"].used, 0.4);
  assert.equal(result.windows["agy:3p-weekly"].source, "agy:usage-command");
  assert.equal(result.windows["agy:3p-5h"].updated_at, UPDATED);
});

test("agy rejects partial quota responses and does not accept invalid fractions", () => {
  const body = fixture("agy-usage.json");
  body.command.data.groups[0].buckets[0].remaining_fraction = 1.2;
  const windows = parseAgyUsage(body, UPDATED);
  assert.equal(windows["agy:gemini-weekly"], undefined);
  const result = fetchAgyUsageJson({ run: () => JSON.stringify(body), now: NOW });
  assert.equal(result.ok, false);
  assert.match(result.reason, /lacked agy:gemini-weekly/);
});
