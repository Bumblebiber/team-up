import "../helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackage } from "../../src/specialists/store.mjs";
import { trustProjectPolicy } from "../../src/specialists/approvals.mjs";
import { launchSpecialist } from "../../src/specialists/launcher.mjs";
import { loadState, runDir } from "../../src/runs/runs.mjs";
import { ISOLATION_FORBIDDEN_CANARIES } from "../../src/harness/isolation-canary.mjs";

/** Stable fake Claude for E2E — version + /usage only; launch path never needs real CLI. */
const FAKE_CLAUDE_VERSION = "2.1.220";

function writeFakeClaude(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env bash
set -euo pipefail
# Deterministic local collector for production-entrypoint E2E.
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s (Claude Code)\\n' ${JSON.stringify(FAKE_CLAUDE_VERSION)}
  exit 0
fi
# Fast subscription usage path: claude -p /usage
if [[ "\${1:-}" == "-p" && "\${2:-}" == "/usage" ]]; then
  cat <<'USAGE'
You are currently using your subscription to power your Claude Code usage

Current session: 10% used · resets Jul 25, 11:00pm (Europe/Berlin)
Current week (all models): 20% used · resets Jul 28, 10am (Europe/Berlin)
Current week (Fable): 5% used · resets Jul 28, 10am (Europe/Berlin)
Current 5h: 15% used · resets Jul 25, 11:30pm (Europe/Berlin)
USAGE
  exit 0
fi
# Launch / print path — succeed quietly (tmux fake never waits on output).
exit 0
`;
  const claudePath = path.join(binDir, "claude");
  fs.writeFileSync(claudePath, script, { mode: 0o755 });
  return claudePath;
}

function writeFakeTmux(binDir, logPath) {
  fs.mkdirSync(binDir, { recursive: true });
  const sessionsPath = `${logPath}.sessions`;
  const script = `#!/usr/bin/env bash
set -euo pipefail
LOG=${JSON.stringify(logPath)}
SESS=${JSON.stringify(sessionsPath)}
printf '%s\\n' "$*" >> "$LOG"
cmd="$1"
shift || true
case "$cmd" in
  new-session)
    name=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "-s" ]]; then name="$2"; break; fi
      shift || true
    done
    if [[ -n "$name" ]]; then
      mkdir -p "$(dirname "$SESS")"
      echo "$name" >> "$SESS"
    fi
    ;;
  send-keys)
    ;;
  kill-session)
    name=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "-t" ]]; then name="$2"; break; fi
      shift || true
    done
    if [[ -n "$name" && -f "$SESS" ]]; then
      grep -vxF "$name" "$SESS" > "$SESS.tmp" || true
      mv "$SESS.tmp" "$SESS"
    fi
    ;;
  has-session)
    name=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "-t" ]]; then name="$2"; break; fi
      shift || true
    done
    if [[ -n "$name" && -f "$SESS" ]] && grep -qxF "$name" "$SESS"; then
      exit 0
    fi
    exit 1
    ;;
  *)
    ;;
esac
exit 0
`;
  const tmuxPath = path.join(binDir, "tmux");
  fs.writeFileSync(tmuxPath, script, { mode: 0o755 });
  return tmuxPath;
}

function validManifest(overrides = {}) {
  return {
    schema_version: 1,
    id: "testing.entrypoint",
    display_name: "Entry",
    version: "0.1.0",
    remit: ["x"],
    anti_remit: ["y"],
    call_types: ["consult", "delegate"],
    accepted_inputs: ["task_description"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
    permissions: {
      filesystem: "project",
      writes: "delegated_only",
      network: false,
      commands: ["project-test"],
    },
    budget: { timeout_seconds: 60 },
    model_profile: { tier: "frontier", reasoning: "max" },
    eval_suite: "evals/evals.json",
    ...overrides,
  };
}

async function withEntrypointEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-ep-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-ep-proj-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-ep-pkg-"));
  const binDir = path.join(home, "bin");
  const tmuxLog = path.join(home, "tmux.log");
  const agentProcsFixture = path.join(home, "agent-procs-fixture.json");
  fs.writeFileSync(agentProcsFixture, "{}\n");
  writeFakeTmux(binDir, tmuxLog);
  writeFakeClaude(binDir);

  const prev = { ...process.env };
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    TEAM_UP_HOME: home,
    TEAM_UP_RUNS: path.join(home, "runs"),
    TEAM_UP_ROSTER: path.join(home, "roster.json"),
    TEAM_UP_USAGE: path.join(home, "usage.json"),
    TEAM_UP_PTY_LOCK: path.join(home, ".usage-pty.lock"),
    TEAM_UP_AGENT_PROCS_FIXTURE: agentProcsFixture,
  };
  Object.assign(process.env, env);

  fs.mkdirSync(path.join(project, ".team-up"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".team-up", "commands.json"),
    JSON.stringify({
      schema_version: 1,
      commands: {
        "project-test": {
          argv: [process.execPath, "-e", "process.stdout.write('ok')"],
          cwd: ".",
          timeout_seconds: 30,
          environment: {},
        },
      },
    })
  );

  fs.writeFileSync(
    env.TEAM_UP_ROSTER,
    JSON.stringify({
      accounts: { anthropic: { kind: "subscription", enabled: true } },
      clis: {
        claude: {
          cmd: ["claude", "--print", "{prompt}"],
        },
      },
      models: {
        "frontier-a": {
          cli: ["claude"],
          account: "anthropic",
          provider: "anthropic",
          reasoning: { max: null },
          priority: 1,
          limit_windows: ["claude:5h"],
        },
        "frontier-b": {
          cli: ["claude"],
          account: "anthropic",
          provider: "anthropic",
          reasoning: { max: null },
          priority: 2,
          limit_windows: ["claude:7d"],
        },
      },
      // frontier-b is the successor a forced handoff moves to.
      roles: { implementer: { chain: ["claude:frontier-a", "claude:frontier-b"] } },
      specialists: { "testing.entrypoint": { role: "implementer" } },
      limits: { handoff_at: 0.95 },
      specialist_handoff: { prepare_at: 0.9, force_at: 0.95 },
      // Collect only needs claude for this fixture.
      subscriptions: ["claude"],
    })
  );
  fs.writeFileSync(
    env.TEAM_UP_USAGE,
    JSON.stringify({
      windows: {
        "claude:5h": { used: 0.5, resets_at: "2099-01-01T00:00:00Z" },
        "claude:7d": { used: 0.1, resets_at: "2099-01-01T00:00:00Z" },
        "cursor:week": { used: 0.99, resets_at: "2099-01-01T00:00:00Z" },
      },
    })
  );

  // Seed harness verification for the fake Claude on PATH (deterministic).
  const cliVersion = FAKE_CLAUDE_VERSION;
  const verDir = path.join(home, "harness-verification", "claude");
  fs.mkdirSync(verDir, { recursive: true });
  fs.writeFileSync(
    path.join(verDir, `${cliVersion}.json`),
    JSON.stringify({
      adapter: "claude",
      cli_version: cliVersion,
      status: "verified",
      native_shell: "denied",
      broker_tool: "passed",
      command_broker: "team-up.command-broker/v1",
      context_isolation: "team-up.context-isolation/v1",
      context_isolation_absent: [...ISOLATION_FORBIDDEN_CANARIES],
    })
  );

  const manifest = validManifest();
  fs.writeFileSync(path.join(pkg, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(pkg, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(pkg, "evals"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "evals", "evals.json"), "[]");
  assert.equal((await installPackage(pkg, env)).ok, true);
  assert.equal(trustProjectPolicy({ project, env }).ok, true);

  try {
    return await fn({ home, project, env, tmuxLog, binDir });
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(pkg, { recursive: true, force: true });
  }
}

function tmuxLines(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
}

test("production launchSpecialist starts the prepared argv once through fake tmux", async () => {
  await withEntrypointEnv(async ({ project, tmuxLog }) => {
    const result = await launchSpecialist({
      specialistId: "testing.entrypoint",
      callType: "delegate",
      objective: "entrypoint smoke",
      project,
      admission: "force",
    });
    assert.ok(result.runId);
    const st = loadState(result.runId);
    assert.equal(st.specialist.id, "testing.entrypoint");
    assert.equal(st.specialist.version, "0.1.0");
    assert.match(st.specialist.checksum, /^sha256:[a-f0-9]+$/);
    assert.ok(st.harness_requirements?.command_broker);
    assert.deepEqual(st.runtime.limit_windows, ["claude:5h"]);
    const lines = tmuxLines(tmuxLog);
    assert.ok(lines.some((l) => l.startsWith("new-session")), lines.join("\n"));
    assert.equal(result.argv[0], "timeout");
    assert.equal(result.argv[1], "--signal=TERM");
    assert.equal(result.argv[2], "--kill-after=5s");
    assert.equal(result.argv[3], "60s");
    assert.equal(result.argv[4], "env");
    assert.equal(result.argv[5], `HOME=${path.join(runDir(result.runId), "claude-home")}`);
    const joined = result.argv.join(" ");
    assert.match(joined, /disallowedTools/);
    assert.match(joined, /mcp-config|claude-mcp/);
    assert.equal(st.worker.tmux.startsWith("team-up-testing-entrypoint-"), true);
  });
});

test("start failure rolls back lease and does not leave watching", async () => {
  await withEntrypointEnv(async ({ project, home }) => {
    // Break tmux for this launch.
    const badBin = path.join(home, "badbin");
    fs.mkdirSync(badBin, { recursive: true });
    fs.writeFileSync(
      path.join(badBin, "tmux"),
      "#!/bin/sh\necho boom >&2\nexit 1\n",
      { mode: 0o755 }
    );
    const prevPath = process.env.PATH;
    process.env.PATH = `${badBin}:${prevPath}`;
    await assert.rejects(
      () =>
        launchSpecialist({
          specialistId: "testing.entrypoint",
          callType: "delegate",
          objective: "fail start",
          project,
          admission: "force",
        }),
      /boom|Command failed|status 1|tmux/i
    );
    process.env.PATH = prevPath;
    // Find the run that was created.
    const runs = fs.readdirSync(process.env.TEAM_UP_RUNS).filter((n) => !n.startsWith("."));
    assert.ok(runs.length >= 1);
    const st = loadState(runs[runs.length - 1]);
    assert.notEqual(st.status, "watching");
  });
});
