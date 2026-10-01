import { debugLogDir, telemetryDir } from "../paths.mjs";
import { telemetryConfig } from "./config.mjs";
import { analyzeRestart, formatRestartReport } from "./restart.mjs";
import { takeSample } from "./sample.mjs";
import { workerFootprint } from "./stats.mjs";
import { appendSample, pruneTelemetry } from "./store.mjs";
import { installTelemetryTimer, lingerEnabled } from "./timer.mjs";

const USAGE =
  "usage: team-up telemetry <sample [--json]|install-timer|restart-report [--refresh] [--json]|stats [--days N] [--json]>";

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function kb(value) {
  return value == null ? "-" : `${Math.round(value / 1024)} MB`;
}

export async function runTelemetryCli(args, io, { env = process.env } = {}) {
  const [sub, ...rest] = args;
  const json = rest.includes("--json");
  if (sub === "sample") {
    const config = telemetryConfig(env);
    const dir = telemetryDir(env);
    const sample = await takeSample();
    appendSample(sample, { dir });
    pruneTelemetry({ dir, retentionDays: config.retention_days });
    if (json) io.out(JSON.stringify(sample));
    else {
      const m = sample.mem;
      io.out(
        `${sample.at} available ${m ? kb(m.MemAvailable) : "-"} of ${m ? kb(m.MemTotal) : "-"}, ` +
        `${sample.workers.length} worker(s) using ${kb(sample.team_up_rss_kb)}`,
      );
    }
    return 0;
  }
  if (sub === "install-timer") {
    const result = installTelemetryTimer();
    io.out(`installed ${result.timerPath}`);
    if (lingerEnabled() !== true) {
      io.out("user timers stop at logout unless lingering is on: loginctl enable-linger $USER");
    }
    return 0;
  }
  if (sub === "restart-report") {
    const config = telemetryConfig(env);
    const report = analyzeRestart({
      telemetryDir: telemetryDir(env),
      logDir: debugLogDir(env),
      thresholds: config.verdict,
      refresh: rest.includes("--refresh"),
    });
    if (json) io.out(JSON.stringify(report, null, 2));
    else if (!report) io.out("no telemetry from an earlier boot; nothing to judge");
    else for (const line of formatRestartReport(report)) io.out(line);
    return 0;
  }
  if (sub === "stats") {
    const days = Number(argValue(rest, "--days") ?? 7);
    if (!Number.isFinite(days) || days <= 0) {
      io.err(USAGE);
      return 1;
    }
    const stats = workerFootprint({ dir: telemetryDir(env), days });
    if (json) {
      io.out(JSON.stringify(stats, null, 2));
      return 0;
    }
    const row = (label, s) =>
      `${label.padEnd(28)} p50 ${kb(s.p50_rss_kb).padStart(8)}  p95 ${kb(s.p95_rss_kb).padStart(8)}  ` +
      `max ${kb(s.max_rss_kb).padStart(8)}  (${s.runs} runs, ${s.samples} samples)`;
    io.out(`${stats.samples} samples over ${days} day(s)`);
    io.out(row("all workers", stats.all));
    for (const [cli, s] of Object.entries(stats.by_cli)) io.out(row(`cli ${cli}`, s));
    for (const [role, s] of Object.entries(stats.by_role)) io.out(row(`role ${role}`, s));
    io.out(`used memory with no worker running: ${kb(stats.baseline_used_kb)} (median of ${stats.baseline_samples} samples)`);
    return 0;
  }
  io.err(USAGE);
  return 1;
}
