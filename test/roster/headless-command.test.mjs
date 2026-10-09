import test from "node:test";
import assert from "node:assert/strict";
import { validateRoster } from "../../src/roster/config.mjs";
import { buildCommand } from "../../src/roster/command.mjs";

const ROSTER = {
  clis: {
    codex: {
      cmd: ["codex", "--model", "{model}", "{prompt}"],
      headless_cmd: [
        "codex", "exec", "-c", "model_reasoning_effort={effort}", "--model", "{model}",
        "--json", "-o", "{last_message}", "{prompt}",
      ],
    },
    agy: {
      cmd: ["agy", "--dangerously-skip-permissions", "--model", "{model}", "--effort", "max", "-i", "{prompt}"],
      headless_cmd: ["agy", "-p", "{prompt}", "--output-format", "stream-json", "--print-timeout", "0", "--model", "{model}", "--effort", "max"],
    },
  },
  models: {
    "gpt-5.6-sol": { cli_model: "gpt-5.6-sol" },
    "gemini-3.8-flash": { cli: ["agy"], reasoning: { max: "high", high: "high", medium: "medium", low: "low" } },
    "claude-opus-4-6-thinking": { cli: ["agy"] },
  },
};

test("buildCommand selects headless template and fills its placeholders", () => {
  assert.deepEqual(buildCommand({
    roster: ROSTER,
    model: "gpt-5.6-sol",
    cli: "codex",
    prompt: "do work",
    effort: "high",
    headless: true,
    lastMessage: "/tmp/run/mailbox/LAST_MESSAGE.md",
  }), [
    "codex", "exec", "-c", "model_reasoning_effort=high", "--model", "gpt-5.6-sol",
    "--json", "-o", "/tmp/run/mailbox/LAST_MESSAGE.md", "do work",
  ]);
});

test("buildCommand keeps interactive cmd when headless is off", () => {
  assert.deepEqual(buildCommand({
    roster: { clis: { codex: { cmd: ["codex", "--model", "{model}", "{prompt}"] } } },
    model: "m",
    cli: "codex",
    prompt: "p",
  }), ["codex", "--model", "m", "p"]);
});

test("buildCommand maps agy effort and keeps headless prompt directly after -p", () => {
  assert.deepEqual(buildCommand({
    roster: ROSTER,
    model: "gemini-3.8-flash",
    cli: "agy",
    prompt: "do work",
    headless: true,
  }), [
    "agy", "-p", "do work", "--output-format", "stream-json", "--print-timeout", "0",
    "--model", "gemini-3.8-flash", "--effort", "high",
  ]);
});

test("buildCommand omits agy's unsupported effort for third-party models", () => {
  assert.deepEqual(buildCommand({
    roster: ROSTER,
    model: "claude-opus-4-6-thinking",
    cli: "agy",
    prompt: "do work",
    effort: "max",
  }), ["agy", "--dangerously-skip-permissions", "--model", "claude-opus-4-6-thinking", "-i", "do work"]);
});

test("validateRoster requires headless_cmd to be an array of strings", () => {
  assert.ok(validateRoster({ clis: { codex: { headless_cmd: "codex exec" } } })
    .errors.some((error) => error.includes("clis.codex.headless_cmd")));
  assert.deepEqual(validateRoster(ROSTER).errors, []);
});

test("validateRoster accepts agy and rejects headless_cmd outside codex, cursor, and agy", () => {
  assert.ok(validateRoster({ clis: { hermes: { cmd: ["hermes"], headless_cmd: ["hermes"] } } })
    .errors.includes("clis.hermes.headless_cmd is only supported for codex, cursor, and agy"));
  assert.deepEqual(validateRoster({ clis: { agy: { cmd: ["agy"], headless_cmd: ["agy", "-p", "{prompt}"] } } }).errors, []);
});

test("startInTmux names the runs dir only when it is not the default", async () => {
  const { startInTmux } = await import("../../src/roster/command.mjs");
  const saved = { TEAM_UP_HOME: process.env.TEAM_UP_HOME, TEAM_UP_RUNS: process.env.TEAM_UP_RUNS };
  const tmuxEnv = () => {
    let args;
    startInTmux({ session: "s", dir: "/tmp", argv: ["x"], runId: "R", exec: (_cmd, a) => { args = a; } });
    return args.filter((a) => a.startsWith("TEAM_UP_RUNS="));
  };
  try {
    delete process.env.TEAM_UP_HOME;
    delete process.env.TEAM_UP_RUNS;
    assert.deepEqual(tmuxEnv(), []);
    process.env.TEAM_UP_RUNS = "/elsewhere/runs";
    assert.deepEqual(tmuxEnv(), ["TEAM_UP_RUNS=/elsewhere/runs"]);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
