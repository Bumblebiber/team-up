import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRun } from "../../src/runs/runs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROSTER_BIN = path.join(ROOT, "src/roster/roster.mjs");

function writeFakeTmux(binDir, logPath) {
  fs.mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
exit 0
`;
  const tmuxPath = path.join(binDir, "tmux");
  fs.writeFileSync(tmuxPath, script, { mode: 0o755 });
}

function tmuxSessionLine(logPath) {
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  return lines.find((l) => l.startsWith("new-session"));
}

function tmuxCwdFromLog(logPath) {
  const line = tmuxSessionLine(logPath);
  assert.ok(line, "expected new-session in tmux log");
  const parts = line.split(" ");
  const idx = parts.indexOf("-c");
  assert.notEqual(idx, -1, line);
  return parts[idx + 1];
}

function tmuxCommandFromLog(logPath) {
  const line = tmuxSessionLine(logPath);
  assert.ok(line, "expected new-session in tmux log");
  const parts = line.split(" ");
  const idx = parts.indexOf("-c");
  assert.notEqual(idx, -1, line);
  return parts.slice(idx + 2).join(" ");
}

function writeFreshUsage(usagePath) {
  const now = new Date().toISOString();
  fs.writeFileSync(
    usagePath,
    JSON.stringify({
      windows: {
        "claude:session": { used: 0.1, updated: now },
        "claude:week": { used: 0.1, updated: now },
        "claude:5h": { used: 0.1, updated: now },
        "cursor:included": { used: 0.1, updated: now },
      },
    }),
  );
}

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-dispatch-pin-"));
  const runsDir = path.join(home, "runs");
  const binDir = path.join(home, "bin");
  const tmuxLog = path.join(home, "tmux.log");
  writeFakeTmux(binDir, tmuxLog);

  const rosterPath = path.join(home, "roster.json");
  fs.writeFileSync(
    rosterPath,
    JSON.stringify({
      clis: {
        claude: { cmd: ["claude", "--model", "{model}", "{prompt}"] },
        cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] },
      },
      models: {
        "model-a": { provider: "anthropic", cli: ["claude"] },
        "composer-2.5": { provider: "cursor", cli: ["cursor"] },
        "claude-opus": {
          provider: "anthropic",
          cli: ["claude"],
          cli_model: "opus",
        },
        "claude-sonnet-5": {
          provider: "anthropic",
          cli: ["claude"],
          cli_model: "sonnet",
        },
      },
      roles: {
        implementer: { chain: ["model-a"] },
      },
    }),
  );

  const usagePath = path.join(home, "usage.json");
  writeFreshUsage(usagePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    TEAM_UP_RUNS: runsDir,
    TEAM_UP_ROSTER: rosterPath,
    TEAM_UP_USAGE: usagePath,
  };

  return { home, runsDir, tmuxLog, rosterPath, usagePath, env, binDir };
}

function dispatch(env, args, { cwd = process.cwd(), expectFail = false } = {}) {
  try {
    const out = execFileSync(process.execPath, [ROSTER_BIN, "dispatch", ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
    if (expectFail) assert.fail(`dispatch should have failed: ${args.join(" ")}`);
    return { ok: true, out };
  } catch (e) {
    if (!expectFail) throw e;
    return { ok: false, code: e.status, stderr: String(e.stderr || ""), stdout: String(e.stdout || "") };
  }
}

test("dispatch --model pins CLI×model even when chain head differs", () => {
  const fx = makeFixture();
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-dispatch-pin-task-"));
  const promptFile = path.join(fx.home, "prompt.md");
  fs.writeFileSync(promptFile, "pin work\n");
  fs.writeFileSync(fx.tmuxLog, "");

  const r = dispatch(fx.env, [
    "--role",
    "implementer",
    "--prompt-file",
    promptFile,
    "--dir",
    taskDir,
    "--model",
    "composer-2.5",
  ]);
  assert.equal(r.ok, true);
  const cmd = tmuxCommandFromLog(fx.tmuxLog);
  assert.match(cmd, /cursor-agent/);
  assert.match(cmd, /composer-2\.5/);
  assert.doesNotMatch(cmd, /model-a/);
});

test("dispatch without --model spawns chain head", () => {
  const fx = makeFixture();
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-dispatch-pin-task-"));
  const promptFile = path.join(fx.home, "prompt.md");
  fs.writeFileSync(promptFile, "chain head\n");
  fs.writeFileSync(fx.tmuxLog, "");

  const r = dispatch(fx.env, [
    "--role",
    "implementer",
    "--prompt-file",
    promptFile,
    "--dir",
    taskDir,
  ]);
  assert.equal(r.ok, true);
  const cmd = tmuxCommandFromLog(fx.tmuxLog);
  assert.match(cmd, /claude/);
  assert.match(cmd, /model-a/);
});

test("dispatch blocked pin exits non-zero with skip reason and no tmux", () => {
  const fx = makeFixture();
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-dispatch-pin-task-"));
  const promptFile = path.join(fx.home, "prompt.md");
  fs.writeFileSync(promptFile, "blocked pin\n");
  fs.writeFileSync(
    fx.usagePath,
    JSON.stringify({
      marked: { "composer-2.5": { until: "2026-12-31T00:00:00Z" } },
    }),
  );
  fs.writeFileSync(fx.tmuxLog, "");

  const r = dispatch(fx.env, [
    "--role",
    "implementer",
    "--prompt-file",
    promptFile,
    "--dir",
    taskDir,
    "--model",
    "composer-2.5",
  ], { expectFail: true });
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /marked limited/);
  assert.equal(tmuxSessionLine(fx.tmuxLog), undefined);
});

test("dispatch ambiguous --model exits 3 without tmux", () => {
  const fx = makeFixture();
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-dispatch-pin-task-"));
  const promptFile = path.join(fx.home, "prompt.md");
  fs.writeFileSync(promptFile, "ambiguous\n");
  fs.writeFileSync(fx.tmuxLog, "");

  const r = dispatch(fx.env, [
    "--role",
    "implementer",
    "--prompt-file",
    promptFile,
    "--dir",
    taskDir,
    "--model",
    "claude",
  ], { expectFail: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.match(r.stderr + r.stdout, /ambiguous/);
  assert.equal(tmuxSessionLine(fx.tmuxLog), undefined);
});

test("dispatch unresolved --model exits 4 without tmux", () => {
  const fx = makeFixture();
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-dispatch-pin-task-"));
  const promptFile = path.join(fx.home, "prompt.md");
  fs.writeFileSync(promptFile, "unresolved\n");
  fs.writeFileSync(fx.tmuxLog, "");

  const r = dispatch(fx.env, [
    "--role",
    "implementer",
    "--prompt-file",
    promptFile,
    "--dir",
    taskDir,
    "--model",
    "weird-unknown-xyz",
  ], { expectFail: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 4);
  assert.match(r.stderr + r.stdout, /unresolved/);
  assert.equal(tmuxSessionLine(fx.tmuxLog), undefined);
});

test("dispatch --model with --run-id and --dir keeps cwd rules", () => {
  const fx = makeFixture();
  const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-cwd-pin-"));
  const dispatchFrom = fs.mkdtempSync(path.join(os.tmpdir(), "tu-dispatch-from-pin-"));
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-dispatch-override-pin-"));
  const promptFile = path.join(fx.home, "prompt.md");
  fs.writeFileSync(promptFile, "cwd pin\n");

  const prev = { ...process.env };
  Object.assign(process.env, fx.env);
  try {
    const state = createRun({
      cwd: runCwd,
      role: "implementer",
      parent: { cli: "claude", attach: "manual" },
      worker: { cli: "cursor" },
      prompt: "cwd pin",
    });

    fs.writeFileSync(fx.tmuxLog, "");
    dispatch(fx.env, [
      "--role",
      "implementer",
      "--prompt-file",
      promptFile,
      "--run-id",
      state.runId,
      "--model",
      "composer-2.5",
    ], { cwd: dispatchFrom });
    assert.equal(tmuxCwdFromLog(fx.tmuxLog), runCwd);

    fs.writeFileSync(fx.tmuxLog, "");
    dispatch(fx.env, [
      "--role",
      "implementer",
      "--prompt-file",
      promptFile,
      "--run-id",
      state.runId,
      "--model",
      "composer-2.5",
      "--dir",
      overrideDir,
    ], { cwd: dispatchFrom });
    assert.equal(tmuxCwdFromLog(fx.tmuxLog), overrideDir);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
  }
});
