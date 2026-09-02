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

function tmuxCwdFromLog(logPath) {
  const line = fs.readFileSync(logPath, "utf8").trim().split("\n").find((l) => l.startsWith("new-session"));
  assert.ok(line, "expected new-session in tmux log");
  const parts = line.split(" ");
  const idx = parts.indexOf("-c");
  assert.notEqual(idx, -1, line);
  return parts[idx + 1];
}

test("dispatch --run-id uses run cwd; explicit --dir overrides", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-dispatch-cwd-"));
  const runsDir = path.join(home, "runs");
  const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-cwd-"));
  const dispatchFrom = fs.mkdtempSync(path.join(os.tmpdir(), "tu-dispatch-from-"));
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-dispatch-override-"));
  const binDir = path.join(home, "bin");
  const tmuxLog = path.join(home, "tmux.log");
  writeFakeTmux(binDir, tmuxLog);

  const rosterPath = path.join(home, "roster.json");
  fs.writeFileSync(
    rosterPath,
    JSON.stringify({
      clis: { claude: { cmd: ["claude", "{prompt}"] } },
      models: { "model-a": { provider: "anthropic", cli: ["claude"] } },
      roles: { implementer: { chain: ["model-a"] } },
    }),
  );

  const usagePath = path.join(home, "usage.json");
  const now = new Date().toISOString();
  fs.writeFileSync(
    usagePath,
    JSON.stringify({
      windows: {
        "claude:session": { used: 0.1, updated: now },
        "claude:week": { used: 0.1, updated: now },
        "claude:5h": { used: 0.1, updated: now },
      },
    }),
  );

  const prev = { ...process.env };
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    TEAM_UP_RUNS: runsDir,
    TEAM_UP_ROSTER: rosterPath,
    TEAM_UP_USAGE: usagePath,
  };
  Object.assign(process.env, env);

  try {
    const state = createRun({
      cwd: runCwd,
      role: "implementer",
      parent: { cli: "claude", attach: "manual" },
      worker: { cli: "claude" },
      prompt: "do work",
    });
    const promptFile = path.join(home, "prompt.md");
    fs.writeFileSync(promptFile, "do work\n");

    fs.writeFileSync(tmuxLog, "");
    execFileSync(
      process.execPath,
      [ROSTER_BIN, "dispatch", "--role", "implementer", "--prompt-file", promptFile, "--run-id", state.runId],
      { cwd: dispatchFrom, env, stdio: "pipe" },
    );
    assert.equal(tmuxCwdFromLog(tmuxLog), runCwd);

    fs.writeFileSync(tmuxLog, "");
    execFileSync(
      process.execPath,
      [ROSTER_BIN, "dispatch", "--role", "implementer", "--prompt-file", promptFile, "--run-id", state.runId, "--dir", overrideDir],
      { cwd: dispatchFrom, env, stdio: "pipe" },
    );
    assert.equal(tmuxCwdFromLog(tmuxLog), overrideDir);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
  }
});
