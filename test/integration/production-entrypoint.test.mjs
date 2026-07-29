import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installPackage } from "../../src/specialists/store.mjs";
import { approveSpecialist } from "../../src/specialists/approvals.mjs";
import { launchSpecialist } from "../../src/specialists/launcher.mjs";
import { loadState, runDir, buildResumePlan } from "../../src/runs/runs.mjs";
import {
  approveCapacityWait,
  cancelCapacityWait,
} from "../../src/supervisor/waits.mjs";
import { usedFraction } from "../../src/supervisor/production.mjs";
import { reclaimStaleLease, createAttempt } from "../../src/supervisor/attempts.mjs";
import { wrapWithSandbox } from "../../src/sandbox/systemd.mjs";
import { createRun } from "../../src/runs/runs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNS_BIN = path.join(ROOT, "src/runs/runs.mjs");
const USAGE_BIN = path.join(ROOT, "src/usage/usage-watcher.mjs");

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
    TEAM_UP_SANDBOX_FORCE_NONE: "1",
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
          sandbox: { runtime_paths: ["/usr/bin", process.execPath, binDir] },
        },
      },
      models: {
        "frontier-a": {
          tier: "frontier",
          cli: ["claude"],
          account: "anthropic",
          provider: "anthropic",
          reasoning: { max: null },
          priority: 1,
          limit_windows: ["claude:5h"],
        },
        "frontier-b": {
          tier: "frontier",
          cli: ["claude"],
          account: "anthropic",
          provider: "anthropic",
          reasoning: { max: null },
          priority: 2,
          limit_windows: ["claude:7d"],
        },
      },
      limits: { handoff_at: 0.95 },
      specialist_handoff: { prepare_at: 0.9, force_at: 0.95 },
      // Exact-tier collect only needs claude for this fixture.
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
    })
  );

  const manifest = validManifest();
  fs.writeFileSync(path.join(pkg, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(pkg, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(pkg, "evals"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "evals", "evals.json"), "[]");
  assert.equal((await installPackage(pkg, env)).ok, true);
  assert.equal(
    (await approveSpecialist({ idAtVersion: "testing.entrypoint@0.1.0", project, env })).ok,
    true
  );

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

test("production launchSpecialist persists descriptor and uses fake tmux new-session", async () => {
  await withEntrypointEnv(async ({ project, tmuxLog }) => {
    const result = await launchSpecialist({
      specialistId: "testing.entrypoint",
      callType: "delegate",
      objective: "entrypoint smoke",
      project,
      sandbox: { probe: () => false },
    });
    assert.ok(result.runId);
    const st = loadState(result.runId);
    assert.equal(st.launch_descriptor?.schema, "team-up.launch-ref/v1");
    assert.ok(st.harness_requirements?.command_broker);
    assert.ok(st.launch_descriptor?.checksum);
    assert.deepEqual(st.runtime.limit_windows, ["claude:5h"]);
    assert.match(st.ACTIVE_LEASE?.owner || fs.readFileSync(path.join(runDir(result.runId), "ACTIVE_LEASE.json"), "utf8"), /tmux:/);
    const lines = tmuxLines(tmuxLog);
    assert.ok(lines.some((l) => l.startsWith("new-session")), lines.join("\n"));
    assert.ok(
      result.argv.some((a) => String(a).includes("mcp-config") || String(a).includes("claude-mcp.json")) ||
        result.argv.includes("--mcp-config") ||
        result.argv.includes("--disallowedTools"),
      result.argv.join(" ")
    );
    assert.ok(result.argv.includes("Bash") || result.argv.includes("--disallowedTools"));
    // Bash denial + MCP config must be in prepared argv
    const joined = result.argv.join(" ");
    assert.match(joined, /disallowedTools/);
    assert.match(joined, /mcp-config|claude-mcp/);
    assert.match(joined, /timeout|RuntimeMaxSec|systemd-run/);
  });
});

test("unrelated provider windows do not raise usedFraction", () => {
  const used = usedFraction(
    { runtime: { limit_windows: ["claude:5h"] } },
    { windows: { "cursor:week": { used: 0.99 }, "claude:5h": { used: 0.1 } } }
  );
  assert.equal(used, 0.1);
  assert.equal(usedFraction({ runtime: { limit_windows: [] } }, { windows: { "cursor:week": { used: 0.99 } } }), 0);
});

test("timeout enforced when isolation is unnecessary", () => {
  const r = wrapWithSandbox({
    command: ["/usr/bin/true"],
    permissions: {},
    cwd: "/tmp",
    timeoutSeconds: 42,
    probe: () => false,
  });
  assert.equal(r.argv[0], "timeout");
  assert.ok(r.argv.includes("42s"));
  assert.equal(r.timeout_enforced, true);
});

test("90 percent usage-watcher --once emits live send-keys; 95 kills and starts successor", async () => {
  await withEntrypointEnv(async ({ project, home, tmuxLog, env }) => {
    const launched = await launchSpecialist({
      specialistId: "testing.entrypoint",
      callType: "delegate",
      objective: "handoff path",
      project,
      sandbox: { probe: () => false },
    });
    const runId = launched.runId;
    const st = loadState(runId);
    st.usage_used = 0.9;
    st.status = "watching";
    st.supervision = { enabled: true, prepare_at: 0.9, force_at: 0.95 };
    saveHelper(st);
    fs.writeFileSync(path.join(runDir(runId), "mailbox", "STATUS"), "watching\n");

    // Clear log after initial launch so we only see watcher actions.
    fs.writeFileSync(tmuxLog, "");

    const once90 = spawnSync(process.execPath, [USAGE_BIN, "--once"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      cwd: ROOT,
    });
    assert.equal(once90.status, 0, once90.stderr + once90.stdout);
    const lines90 = tmuxLines(tmuxLog);
    assert.ok(
      lines90.some((l) => l.startsWith("send-keys")),
      `expected send-keys at 90%: ${lines90.join(" | ")}`
    );

    // Force 95% with no checkpoint → force handoff to frontier-b (different window).
    const st2 = loadState(runId);
    st2.usage_used = 0.95;
    st2.status = "handoff_preparing";
    saveHelper(st2);
    fs.writeFileSync(tmuxLog, "");

    const once95 = spawnSync(process.execPath, [USAGE_BIN, "--once"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      cwd: ROOT,
    });
    assert.equal(once95.status, 0, once95.stderr + once95.stdout);
    const lines95 = tmuxLines(tmuxLog);
    assert.ok(lines95.some((l) => l.startsWith("kill-session")), lines95.join(" | "));
    const news = lines95.filter((l) => l.startsWith("new-session"));
    assert.equal(news.length, 1, lines95.join(" | ") + "\n" + once95.stdout);
    const st3 = loadState(runId);
    assert.ok(st3.checkpoint?.status === "partial" || st3.current_attempt_id);
    assert.ok(st3.harness_requirements?.command_broker || st3.launch_descriptor?.checksum);
  });
});

function saveHelper(st) {
  const p = path.join(runDir(st.runId), "STATE.json");
  fs.writeFileSync(p, `${JSON.stringify(st, null, 2)}\n`);
}

test("cancel-wait then runs resume spawns no worker", async () => {
  await withEntrypointEnv(async ({ project, tmuxLog, env }) => {
    const launched = await launchSpecialist({
      specialistId: "testing.entrypoint",
      callType: "delegate",
      objective: "cancel wait",
      project,
      sandbox: { probe: () => false },
    });
    const runId = launched.runId;
    approveCapacityWait({
      runId,
      nextResetAt: "2026-07-25T10:00:00Z",
      now: "2026-07-25T09:00:00Z",
    });
    const cancel = spawnSync(
      process.execPath,
      [RUNS_BIN, "cancel-wait", runId, "--reason", "human"],
      { encoding: "utf8", env: { ...process.env, ...env }, cwd: ROOT }
    );
    assert.equal(cancel.status, 0, cancel.stderr);

    // Pretend worker tmux is gone.
    const st = loadState(runId);
    st.worker = { ...(st.worker || {}), tmux: "dead-session-xyz" };
    saveHelper(st);
    fs.writeFileSync(tmuxLog, "");

    const plan = buildResumePlan(st, { tmuxExists: () => false });
    assert.ok(!plan.actions.some((a) => a.kind === "spawn_worker"), JSON.stringify(plan));

    const resume = spawnSync(process.execPath, [RUNS_BIN, "resume"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      cwd: ROOT,
    });
    assert.equal(resume.status, 0, resume.stderr + resume.stdout);
    // Give async capacity resume a moment.
    await new Promise((r) => setTimeout(r, 200));
    const lines = tmuxLines(tmuxLog);
    assert.ok(
      !lines.some((l) => l.startsWith("new-session")),
      `forbidden spawn after cancel-wait: ${lines.join(" | ")}`
    );
  });
});

test("approved due wait via runs resume starts through descriptor path", async () => {
  await withEntrypointEnv(async ({ project, tmuxLog, env }) => {
    const launched = await launchSpecialist({
      specialistId: "testing.entrypoint",
      callType: "delegate",
      objective: "due wait",
      project,
      sandbox: { probe: () => false },
    });
    const runId = launched.runId;
    // Release current lease so resume can acquire a new attempt.
    const st0 = loadState(runId);
    const leasePath = path.join(runDir(runId), "ACTIVE_LEASE.json");
    const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    lease.released_at = "2026-07-25T09:00:00Z";
    lease.release_reason = "test";
    fs.writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`);

    approveCapacityWait({
      runId,
      nextResetAt: "2026-07-25T10:00:00Z",
      now: "2026-07-25T09:00:00Z",
    });
    fs.writeFileSync(tmuxLog, "");

    const resume = spawnSync(process.execPath, [RUNS_BIN, "resume"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        // force "now" via clock? resumeDueWaits uses Date — set wait in the past
      },
      cwd: ROOT,
    });
    assert.equal(resume.status, 0, resume.stderr + resume.stdout);
    await new Promise((r) => setTimeout(r, 400));
    const lines = tmuxLines(tmuxLog);
    assert.ok(lines.some((l) => l.startsWith("new-session")), lines.join(" | ") + "\n" + resume.stdout);
    const st = loadState(runId);
    assert.equal(st.status, "watching");
    assert.ok(st.launch_descriptor);
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
          sandbox: { probe: () => false },
        }),
      /boom|Command failed|status 1|tmux/i
    );
    process.env.PATH = prevPath;
    // Find the run that was created.
    const runs = fs.readdirSync(process.env.TEAM_UP_RUNS).filter((n) => !n.startsWith("."));
    assert.ok(runs.length >= 1);
    const st = loadState(runs[runs.length - 1]);
    assert.notEqual(st.status, "watching");
    const lease = JSON.parse(
      fs.readFileSync(path.join(runDir(st.runId), "ACTIVE_LEASE.json"), "utf8")
    );
    assert.ok(lease.released_at, JSON.stringify(lease));
  });
});

test("tmux lease owner is retained while launcher pid is dead pattern", async () => {
  await withEntrypointEnv(async ({ project }) => {
    const launched = await launchSpecialist({
      specialistId: "testing.entrypoint",
      callType: "delegate",
      objective: "lease retain",
      project,
      sandbox: { probe: () => false },
    });
    const runId = launched.runId;
    const leasePath = path.join(runDir(runId), "ACTIVE_LEASE.json");
    const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    assert.match(lease.owner, /^tmux:/);
    const reclaimed = reclaimStaleLease({
      runId,
      now: new Date().toISOString(),
      maxAgeMs: 60_000 * 60,
    });
    assert.equal(reclaimed.ok, false);
    assert.equal(reclaimed.reason, "not_stale");
  });
});

test("dead lock owner recovers without permanent lock_busy", async () => {
  await withEntrypointEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:x",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude" },
      prompt: "hi",
    });
    const lockPath = path.join(runDir(run.runId), "ATTEMPTS.lock");
    fs.writeFileSync(lockPath, "99999999\n0\n");
    const a = createAttempt({ runId: run.runId, runtime: { cli: "claude", model: "m" } });
    assert.ok(a.id);
  });
});
