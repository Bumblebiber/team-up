import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.mjs";
import { validateRoster } from "../../src/roster/config.mjs";
import {
  triage,
  resolveTriageDispatch,
  applyLowConfidenceRoundUp,
  bumpTier,
  shouldUseActiveTriage,
  shouldRunTriage,
  isRoleTriagable,
  lookupTriageKey,
} from "../../src/roster/triage.mjs";
import { resolveProfile } from "../../src/roster/profile.mjs";
import { spawnInTmux } from "../../src/roster/roster.mjs";

const TEST_KEY = "test-key";

const baseRoster = {
  triage: {
    enabled: true,
    mode: "shadow",
    endpoint: "https://example.test/decisions",
    key_env: "OPENROUTER_API_KEY",
    model: "jev-latest",
    timeout_ms: 100,
    min_confidence: 0.6,
    active_share: 0,
    roles: ["implementer", "researcher", "test-writer"],
  },
  accounts: {
    cursor: { kind: "subscription", enabled: true },
    api: { kind: "credit", enabled: true, remaining: 100 },
  },
  clis: {
    cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] },
    codex: { cmd: ["codex", "--model", "{model}", "-c", "model_reasoning_effort={effort}", "{prompt}"] },
  },
  roles: {
    implementer: { chain: ["cursor:mediumA"] },
    planner: { chain: ["codex:frontier"] },
  },
  models: {
    mediumA: {
      tier: "medium",
      cli: ["cursor"],
      account: "cursor",
      reasoning: { low: null, medium: "medium", high: "high" },
      priority: 1,
    },
    mediumB: {
      tier: "medium",
      cli: ["codex"],
      account: "api",
      reasoning: { medium: "medium" },
      priority: 2,
    },
    highA: {
      tier: "high",
      cli: ["cursor"],
      account: "cursor",
      reasoning: { medium: "medium" },
      priority: 1,
    },
    frontier: {
      tier: "frontier",
      cli: ["codex"],
      account: "api",
      reasoning: { max: "xhigh" },
      priority: 1,
    },
    lowA: {
      tier: "low",
      cli: ["cursor"],
      account: "cursor",
      reasoning: { low: null },
      priority: 1,
    },
  },
};

function jevResponse(tierIdx, reasoningIdx, { tierConf = 1, reasoningConf = 1 } = {}) {
  return {
    model: "typesafe/jev-1.13-20260917",
    answers: {
      tier: {
        type: "score",
        score: tierIdx,
        confidence: tierConf,
        probabilities: {},
      },
      reasoning: {
        type: "score",
        score: reasoningIdx,
        confidence: reasoningConf,
        probabilities: {},
      },
    },
  };
}

function fakeFetch(response, { status = 200, delayMs = 0 } = {}) {
  return async (_url, opts) => {
    if (delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (opts?.signal) {
      opts.signal.addEventListener("abort", () => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      });
    }
    return {
      status,
      async json() {
        if (typeof response === "function") return response();
        return response;
      },
    };
  };
}

function envWithKey(key = TEST_KEY) {
  return { OPENROUTER_API_KEY: key };
}

test("happy path maps score levels to tier and reasoning labels", async () => {
  const fetchFn = fakeFetch(jevResponse(2, 1)); // high, medium
  const result = await triage({
    roster: baseRoster,
    prompt: "Implement feature X",
    role: "implementer",
    env: envWithKey(),
    fetch: fetchFn,
    now: Date.now(),
  });
  assert.equal(result.source, "jev");
  assert.deepEqual(result.profile, { tier: "high", reasoning: "medium" });
  assert.equal(result.fallback_reason, null);
  assert.ok(result.latency_ms >= 0);
});

test("fractional scores round to nearest level", async () => {
  const result = await triage({
    roster: baseRoster,
    prompt: "Implement feature X",
    role: "implementer",
    env: envWithKey(),
    fetch: fakeFetch(jevResponse(1.43, 0.48)),
  });
  assert.equal(result.source, "jev");
  assert.deepEqual(result.profile, { tier: "medium", reasoning: "low" });
});

test("timeout returns fallback", async () => {
  const fetchFn = async (_url, opts) => {
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
  const result = await triage({
    roster: { ...baseRoster, triage: { ...baseRoster.triage, timeout_ms: 5 } },
    prompt: "slow",
    role: "implementer",
    env: envWithKey(),
    fetch: fetchFn,
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.fallback_reason, "timeout");
  assert.equal(result.profile, null);
});

test("HTTP 422 returns http_4xx fallback", async () => {
  const result = await triage({
    roster: baseRoster,
    prompt: "x",
    role: "implementer",
    env: envWithKey(),
    fetch: fakeFetch({}, { status: 422 }),
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.fallback_reason, "http_4xx");
});

test("HTTP 5xx returns http_5xx fallback", async () => {
  const result = await triage({
    roster: baseRoster,
    prompt: "x",
    role: "implementer",
    env: envWithKey(),
    fetch: fakeFetch({}, { status: 503 }),
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.fallback_reason, "http_5xx");
});

test("invalid out-of-range index returns invalid_answer fallback", async () => {
  const result = await triage({
    roster: baseRoster,
    prompt: "x",
    role: "implementer",
    env: envWithKey(),
    fetch: fakeFetch(jevResponse(99, 1)),
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.fallback_reason, "invalid_answer");
});

test("low confidence rounds tier and reasoning up, keeps source jev", async () => {
  const result = await triage({
    roster: baseRoster,
    prompt: "x",
    role: "implementer",
    env: envWithKey(),
    fetch: fakeFetch(jevResponse(1, 0, { tierConf: 0.4, reasoningConf: 0.2 })), // medium/low
  });
  assert.equal(result.source, "jev");
  assert.equal(result.fallback_reason, "low_confidence");
  assert.deepEqual(result.profile, { tier: "high", reasoning: "medium" });
});

test("low confidence tier round-up caps at frontier", () => {
  const { profile, lowConfidence } = applyLowConfidenceRoundUp(
    { tier: "frontier", reasoning: "max" },
    { tier: 0.1, reasoning: 0.1 },
    0.6,
  );
  assert.equal(lowConfidence, true);
  assert.equal(profile.tier, "frontier");
  assert.equal(profile.reasoning, "max");
});

test("bumpTier stops at frontier", () => {
  assert.equal(bumpTier("high"), "frontier");
  assert.equal(bumpTier("frontier"), "frontier");
});

test("PROFILE_UNAVAILABLE bumps tier up then resolves", () => {
  const roster = {
    ...baseRoster,
    models: {
      highA: baseRoster.models.highA,
      frontier: baseRoster.models.frontier,
    },
  };
  const triageOutput = {
    source: "jev",
    profile: { tier: "medium", reasoning: "medium" },
    confidence: { tier: 1, reasoning: 1 },
    fallback_reason: null,
    latency_ms: 10,
  };
  const unavailable = resolveProfile({
    roster,
    profile: triageOutput.profile,
    usage: {},
  });
  assert.equal(unavailable.code, "PROFILE_UNAVAILABLE");

  const dispatch = resolveTriageDispatch({
    roster,
    usage: {},
    triageOutput,
    role: "implementer",
  });
  assert.equal(dispatch.useRoleChain, false);
  assert.equal(dispatch.cell.model, "highA");
});

test("PROFILE_UNAVAILABLE after bump falls back to role chain", () => {
  const roster = {
    ...baseRoster,
    models: { frontier: baseRoster.models.frontier },
  };
  const dispatch = resolveTriageDispatch({
    roster,
    usage: {},
    triageOutput: {
      profile: { tier: "low", reasoning: "low" },
    },
    role: "implementer",
  });
  assert.equal(dispatch.useRoleChain, true);
  assert.equal(dispatch.cell, null);
});

test("active triage selection survives subscription usage refresh", async () => {
  let refreshes = 0;
  let launched;
  await spawnInTmux({
    roster: {
      ...baseRoster,
      subscriptions: ["cursor"],
      triage: { ...baseRoster.triage, mode: "active", active_share: 1 },
    },
    role: "implementer",
    dir: "/tmp",
    prompt: "Implement complex feature",
    useTriage: true,
    env: envWithKey(),
    usageSnapshot: { windows: {}, marked: {} },
    readUsage: () => ({
      windows: { "cursor:included": { used: 0.1, updated_at: new Date().toISOString() } },
      marked: {},
    }),
    refreshUsage: async () => { refreshes++; return { ok: true }; },
    fetchFn: fakeFetch(jevResponse(2, 1)),
    spawn: async (options) => { launched = options; },
    // Without this the real ~/.team-up/runs gets a `starting` run per test run.
    createRun: () => ({ runId: "test-run" }),
  });
  assert.equal(refreshes, 1);
  assert.equal(launched.model, "highA");
  assert.equal(launched.cli, "cursor");
  assert.deepEqual(launched.triage.profile, { tier: "high", reasoning: "medium" });
  assert.equal(launched.triage.mode, "active");
  assert.equal(launched.triage.applied, true);
});

test("explicit model pin takes precedence over active triage", async () => {
  let launched;
  await spawnInTmux({
    roster: {
      ...baseRoster,
      subscriptions: ["none"],
      triage: { ...baseRoster.triage, mode: "active", active_share: 1 },
    },
    role: "implementer",
    dir: "/tmp",
    prompt: "Implement complex feature",
    modelPin: "cursor:mediumA",
    useTriage: true,
    env: envWithKey(),
    usageSnapshot: { windows: {}, marked: {} },
    fetchFn: async () => { throw new Error("triage must not run for hard pin"); },
    spawn: async (options) => { launched = options; },
    // Without this the real ~/.team-up/runs gets a `starting` run per test run.
    createRun: () => ({ runId: "test-run" }),
  });
  assert.equal(launched.model, "mediumA");
  assert.equal(launched.cli, "cursor");
  assert.equal(launched.triage, undefined);
});

test("missing key returns no_key fallback", async () => {
  const result = await triage({
    roster: baseRoster,
    prompt: "x",
    role: "implementer",
    env: {},
    fetch: fakeFetch(jevResponse(1, 1)),
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.fallback_reason, "no_key");
  assert.ok(Array.isArray(result.key_files_checked));
});

test("role not in allowlist skips triage call", async () => {
  let called = false;
  const result = await triage({
    roster: baseRoster,
    prompt: "x",
    role: "planner",
    env: envWithKey(),
    fetch: async () => {
      called = true;
      return { status: 200, json: async () => jevResponse(1, 1) };
    },
  });
  assert.equal(called, false);
  assert.equal(result.source, "fallback");
  assert.equal(result.profile, null);
  assert.equal(result.fallback_reason, "role_not_allowlisted");
  assert.equal(isRoleTriagable(baseRoster, "planner"), false);
});

test("shadow vs active: active_share gating is deterministic", () => {
  const roster = {
    triage: { active_share: 0.5 },
  };
  assert.equal(shouldUseActiveTriage(roster, () => 0.2), true);
  assert.equal(shouldUseActiveTriage(roster, () => 0.8), false);
  assert.equal(shouldUseActiveTriage({ triage: { active_share: 0 } }), false);
  assert.equal(shouldUseActiveTriage({ triage: { active_share: 1 } }), true);
});

test("triage disabled returns fallback without fetch", async () => {
  let called = false;
  const result = await triage({
    roster: { triage: { enabled: false } },
    prompt: "x",
    role: "implementer",
    env: envWithKey(),
    fetch: async () => {
      called = true;
      return { status: 200, json: async () => jevResponse(1, 1) };
    },
  });
  assert.equal(called, false);
  assert.equal(result.source, "fallback");
  assert.equal(result.fallback_reason, "disabled");
});

function withTempRoster(roster, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-triage-"));
  const rosterPath = path.join(home, "roster.json");
  const usagePath = path.join(home, "usage.json");
  fs.writeFileSync(rosterPath, JSON.stringify(roster));
  fs.writeFileSync(usagePath, "{}");
  const prev = {
    TEAM_UP_ROSTER: process.env.TEAM_UP_ROSTER,
    TEAM_UP_USAGE: process.env.TEAM_UP_USAGE,
  };
  process.env.TEAM_UP_ROSTER = rosterPath;
  process.env.TEAM_UP_USAGE = usagePath;
  return (async () => {
    try {
      return await fn({ rosterPath, usagePath, home });
    } finally {
      if (prev.TEAM_UP_ROSTER === undefined) delete process.env.TEAM_UP_ROSTER;
      else process.env.TEAM_UP_ROSTER = prev.TEAM_UP_ROSTER;
      if (prev.TEAM_UP_USAGE === undefined) delete process.env.TEAM_UP_USAGE;
      else process.env.TEAM_UP_USAGE = prev.TEAM_UP_USAGE;
      fs.rmSync(home, { recursive: true, force: true });
    }
  })();
}

const pickRoster = {
  accounts: {
    cursor: { kind: "subscription", enabled: true },
  },
  clis: {
    cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] },
  },
  roles: {
    implementer: {
      chain: [{ cli: "cursor", model: "composer-2.5", effort: "medium" }],
    },
  },
  models: {
    "composer-2.5": {
      provider: "cursor",
      tier: "medium",
      cli: ["cursor"],
      account: "cursor",
      reasoning: { medium: null },
    },
    "claude-sonnet": {
      provider: "anthropic",
      tier: "medium",
      cli: ["cursor"],
      account: "cursor",
      reasoning: { medium: "medium" },
      priority: 2,
    },
  },
};

test("pick rejects role and profile together", async () => {
  const errors = [];
  const code = await runCli(["pick", "--role", "implementer", "--profile", "high:medium", "--json"], {
    out: () => {},
    err: (line) => errors.push(line),
  });
  assert.equal(code, 1);
  assert.match(errors[0], /usage: team-up pick/);
});

test("pick --json role path matches output shape", async () => {
  await withTempRoster(pickRoster, async () => {
    const lines = [];
    const code = await runCli(["pick", "--role", "implementer", "--json"], {
      out: (l) => lines.push(l),
      err: () => {},
    });
    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.model, "composer-2.5");
    assert.equal(parsed.cli, "cursor");
    assert.equal(parsed.effort, "medium");
    assert.ok(Array.isArray(parsed.skipped));
    assert.deepEqual(parsed.quota_blocked, []);
  });
});

test("pick --json profile path includes quota_blocked", async () => {
  await withTempRoster(pickRoster, async () => {
    const lines = [];
    const code = await runCli(["pick", "--profile", "medium:medium", "--json"], {
      out: (l) => lines.push(l),
      err: () => {},
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.model, "claude-sonnet");
    assert.equal(parsed.cli, "cursor");
    assert.equal(parsed.effort, "medium");
    assert.ok(Array.isArray(parsed.skipped));
    assert.ok(Array.isArray(parsed.quota_blocked));
  });
});

test("pick without --json text output unchanged", async () => {
  await withTempRoster(pickRoster, async () => {
    const lines = [];
    const errors = [];
    const code = await runCli(["pick", "--role", "implementer"], {
      out: (l) => lines.push(l),
      err: (l) => errors.push(l),
    });
    assert.equal(code, 0);
    assert.deepEqual(lines, ["model: composer-2.5", "cli: cursor", "effort: medium"]);
    assert.deepEqual(errors, []);
  });
});

test("validateRoster rejects triage.api_key", () => {
  const { errors } = validateRoster({
    triage: { enabled: false, api_key: "secret" },
  });
  assert.ok(errors.some((e) => e.includes("triage.api_key")));
});

test("validateRoster accepts triage block without api_key", () => {
  const { errors } = validateRoster({
    triage: {
      enabled: false,
      mode: "shadow",
      roles: ["implementer"],
    },
  });
  assert.equal(errors.length, 0);
});

test("validateRoster accepts triage.key_file", () => {
  const { errors } = validateRoster({
    triage: {
      enabled: false,
      key_file: "~/.hermes/.env",
    },
  });
  assert.equal(errors.length, 0);
});

test("shouldRunTriage runs when enabled, allowlisted, no pin, no opt-out", () => {
  const roster = { triage: { enabled: true, roles: ["implementer"] } };
  assert.equal(shouldRunTriage({ roster, role: "implementer" }), true);
  assert.equal(shouldRunTriage({ roster, role: "implementer", noTriage: true }), false);
  assert.equal(shouldRunTriage({ roster, role: "implementer", modelPin: "cursor:mediumA" }), false);
  assert.equal(shouldRunTriage({ roster, role: "planner" }), false);
  assert.equal(shouldRunTriage({ roster: { triage: { enabled: false, roles: ["implementer"] } }, role: "implementer" }), false);
});

test("lookupTriageKey prefers env over key_file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-key-"));
  const keyFile = path.join(home, "secrets.env");
  fs.writeFileSync(keyFile, 'OPENROUTER_API_KEY="file-key"\n', { mode: 0o600 });
  const roster = {
    triage: {
      key_env: "OPENROUTER_API_KEY",
      key_file: keyFile,
    },
  };
  const fromEnv = lookupTriageKey({ roster, env: { OPENROUTER_API_KEY: "env-key" } });
  assert.equal(fromEnv.key, "env-key");
  assert.equal(fromEnv.source, "env");

  const fromFile = lookupTriageKey({ roster, env: { TEAM_UP_HOME: home } });
  assert.equal(fromFile.key, "file-key");
  assert.equal(fromFile.source, "file");
  fs.rmSync(home, { recursive: true, force: true });
});

test("lookupTriageKey parses comments, blanks, and quoted values", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-key-"));
  const keyFile = path.join(home, "secrets.env");
  fs.writeFileSync(
    keyFile,
    "# comment\n\nOTHER=x\nOPENROUTER_API_KEY=\'quoted-key\'\n",
    { mode: 0o600 },
  );
  const roster = { triage: { key_env: "OPENROUTER_API_KEY", key_file: keyFile } };
  const hit = lookupTriageKey({ roster, env: { TEAM_UP_HOME: home } });
  assert.equal(hit.key, "quoted-key");
  fs.rmSync(home, { recursive: true, force: true });
});

test("lookupTriageKey refuses group/world-readable files", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-key-"));
  const keyFile = path.join(home, "leaky.env");
  fs.writeFileSync(keyFile, "OPENROUTER_API_KEY=secret-value\n", { mode: 0o644 });
  const roster = { triage: { key_env: "OPENROUTER_API_KEY", key_file: keyFile } };
  const warnings = [];
  const hit = lookupTriageKey({
    roster,
    env: { TEAM_UP_HOME: home },
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(hit.key, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /leaky\.env/);
  assert.doesNotMatch(warnings.join("\n"), /secret-value/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("lookupTriageKey with partial env does not read operator home secrets", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-key-"));
  const operatorHome = fs.mkdtempSync(path.join(os.tmpdir(), "tu-op-"));
  const operatorSecretsDir = path.join(operatorHome, ".team-up");
  fs.mkdirSync(operatorSecretsDir, { recursive: true });
  fs.writeFileSync(
    path.join(operatorSecretsDir, "secrets.env"),
    "OPENROUTER_API_KEY=operator-leak-key\n",
    { mode: 0o600 },
  );
  const keyFile = path.join(home, "fixture.env");
  fs.writeFileSync(keyFile, "OPENROUTER_API_KEY=fixture-key\n", { mode: 0o600 });
  const roster = { triage: { key_env: "OPENROUTER_API_KEY", key_file: keyFile } };

  const prevHome = process.env.HOME;
  process.env.HOME = operatorHome;
  try {
    const fromFixture = lookupTriageKey({ roster, env: {} });
    assert.equal(fromFixture.key, "fixture-key");
    assert.equal(fromFixture.source, "file");

    fs.writeFileSync(path.join(home, "secrets.env"), "OPENROUTER_API_KEY=team-up-key\n", {
      mode: 0o600,
    });
    const fromSecrets = lookupTriageKey({ roster, env: { TEAM_UP_HOME: home } });
    assert.equal(fromSecrets.key, "team-up-key");
    assert.equal(fromSecrets.filePath, path.join(home, "secrets.env"));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(operatorHome, { recursive: true, force: true });
  }
});

test("triage reads key from key_file without env", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-key-"));
  const keyFile = path.join(home, "secrets.env");
  fs.writeFileSync(keyFile, "OPENROUTER_API_KEY=test-key\n", { mode: 0o600 });
  const roster = {
    ...baseRoster,
    triage: { ...baseRoster.triage, key_file: keyFile },
  };
  const result = await triage({
    roster,
    prompt: "x",
    role: "implementer",
    env: {},
    fetch: fakeFetch(jevResponse(1, 1)),
  });
  assert.equal(result.source, "jev");
  fs.rmSync(home, { recursive: true, force: true });
});
