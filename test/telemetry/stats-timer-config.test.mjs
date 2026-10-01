import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workerFootprint } from "../../src/telemetry/stats.mjs";
import { appendSample } from "../../src/telemetry/store.mjs";
import { installTelemetryTimer, renderTelemetryUnits } from "../../src/telemetry/timer.mjs";
import { telemetryConfig } from "../../src/telemetry/config.mjs";
import { runTelemetryCli } from "../../src/telemetry/cli.mjs";

test("workerFootprint reports percentiles per cli and role, and the idle baseline", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-stats-"));
  try {
    const now = new Date("2026-10-01T12:00:00Z");
    // Older than the window: ignored.
    appendSample({ at: "2026-09-20T10:00:00Z", workers: [{ runId: "old", cli: "claude", role: "code", rss_kb: 9e9 }] }, { dir });
    for (let i = 1; i <= 20; i++) {
      appendSample({
        at: new Date(now.getTime() - i * 60_000).toISOString(),
        mem: { MemTotal: 1000, MemAvailable: 600 },
        workers: [
          { runId: "a", cli: "claude", role: "code", rss_kb: i * 10 },
          { runId: "b", cli: "codex", role: "review", rss_kb: 1000 },
        ],
      }, { dir });
    }
    for (const used of [100, 200, 300]) {
      appendSample({ at: new Date(now.getTime() - 30 * 60_000 - used).toISOString(), mem: { MemTotal: 1000, MemAvailable: 1000 - used }, workers: [] }, { dir });
    }
    const s = workerFootprint({ dir, days: 7, now });
    assert.equal(s.samples, 23);
    assert.deepEqual(s.by_cli.claude, { samples: 20, runs: 1, p50_rss_kb: 100, p95_rss_kb: 190, max_rss_kb: 200 });
    assert.equal(s.by_cli.codex.p95_rss_kb, 1000);
    assert.equal(s.by_role.review.runs, 1);
    assert.equal(s.all.samples, 40);
    assert.equal(s.all.runs, 2);
    assert.equal(s.baseline_used_kb, 200);
    assert.equal(s.baseline_samples, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry units run the sampler every 30 seconds with quoted absolute paths", () => {
  const units = renderTelemetryUnits({ nodePath: "/opt/node%i/bin/node", cliPath: "/opt/team up/bin/team-up.mjs" });
  assert.match(units.service, /ExecStart="\/opt\/node%%i\/bin\/node" "\/opt\/team up\/bin\/team-up\.mjs" telemetry sample/);
  assert.match(units.service, /Type=oneshot/);
  assert.match(units.timer, /OnBootSec=30s/);
  assert.match(units.timer, /OnUnitActiveSec=30s/);
  assert.match(units.timer, /AccuracySec=5s/);
  assert.throws(() => renderTelemetryUnits({ nodePath: "/x\n", cliPath: "/y" }), /control character/i);
});

test("installTelemetryTimer writes units then enables the timer", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-tel-timer-"));
  const calls = [];
  try {
    const result = installTelemetryTimer({
      home, nodePath: "/opt/node", cliPath: "/opt/cli.mjs", exec: (bin, args) => calls.push([bin, args]),
    });
    assert.ok(fs.existsSync(result.servicePath));
    assert.ok(fs.existsSync(result.timerPath));
    assert.deepEqual(calls, [
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "--now", "team-up-telemetry.timer"]],
    ]);
    assert.throws(() => installTelemetryTimer({ home, nodePath: "node", cliPath: "/x", exec: () => {} }), /absolute/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("telemetryConfig applies defaults and refuses bad values", () => {
  assert.deepEqual(telemetryConfig({}, { roster: null }), {
    retention_days: 7,
    verdict: { mem_available_ratio: 0.05, psi_full_avg10: 20, team_up_share: 0.5 },
  });
  const custom = telemetryConfig({}, { roster: { telemetry: { retention_days: 3, verdict: { team_up_share: 0.7 } } } });
  assert.equal(custom.retention_days, 3);
  assert.equal(custom.verdict.team_up_share, 0.7);
  assert.throws(() => telemetryConfig({}, { roster: { telemetry: { retention_days: 0 } } }), /retention_days/);
  assert.throws(() => telemetryConfig({}, { roster: { telemetry: { verdict: { share: 1 } } } }), /unknown telemetry\.verdict\.share/);
  assert.throws(() => telemetryConfig({}, { roster: { telemetry: { verdict: { psi_full_avg10: "x" } } } }), /non-negative number/);
});

test("telemetry stats and restart-report run against TEAM_UP_HOME", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-tel-cli-"));
  const out = [];
  const io = { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) };
  try {
    const env = { TEAM_UP_HOME: home, O9K_HOME: home };
    assert.equal(await runTelemetryCli(["stats", "--json"], io, { env }), 0);
    assert.equal(JSON.parse(out.pop()).samples, 0);
    assert.equal(await runTelemetryCli(["stats", "--days", "-1"], io, { env }), 1);
    assert.equal(await runTelemetryCli(["bogus"], io, { env }), 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
