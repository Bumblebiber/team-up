import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readBootId } from "./proc.mjs";
import { readSamples } from "./store.mjs";

export const REPORT_SCHEMA = "team-up.restart-report/v1";
export const VERDICTS = ["team_up_suspected", "other_cause", "clean_shutdown", "unknown"];
export const DEFAULT_THRESHOLDS = Object.freeze({
  mem_available_ratio: 0.05,
  psi_full_avg10: 20,
  team_up_share: 0.5,
});
const WINDOW_MS = 10 * 60 * 1000;

// Markers an orderly stop leaves at the end of a boot. The system manager
// names its targets "System Shutdown"/"System Reboot"/…; a user manager stops
// with "Shutdown" and "Exit the Session", which is all a user outside the
// systemd-journal group gets to see.
const ORDERLY = /Reached target (?:System )?(?:Shutdown|Power[- ]?Off|Reboot|Halt|Kexec)\b|Reached target (?:Final Step|Exit the Session)\b/i;
const LIMITED = /not seeing messages from other users and the system|insufficient permissions/i;

// ---------------------------------------------------------------------------
// Journal access. Each call answers { ok, entries, limited } or { ok: false,
// error }; nothing here throws, because a missing privilege is a gap in the
// evidence, not a failure of the report.

function journalBootArg(bootId) {
  return String(bootId).replaceAll("-", "");
}

function runJournalctl(args) {
  const r = spawnSync("journalctl", ["--no-pager", "-o", "json", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { ok: false, error: `journalctl: ${r.error.message}` };
  const stderr = String(r.stderr || "");
  // `--grep` with no match exits non-zero on some versions without a word on
  // stderr; that is an empty answer, not an error.
  if (r.status !== 0 && !String(r.stdout || "").trim() &&
      (!stderr.trim() || /No entries/i.test(stderr))) {
    return { ok: true, entries: [], limited: LIMITED.test(stderr) };
  }
  if (r.status !== 0) {
    return { ok: false, error: stderr.trim().split("\n")[0] || `journalctl exited ${r.status}`, stderr };
  }
  const entries = [];
  for (const line of String(r.stdout || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line);
      // MESSAGE is an array of bytes when it is not valid UTF-8; not ours.
      if (typeof raw.MESSAGE !== "string") continue;
      const us = Number(raw.__REALTIME_TIMESTAMP);
      entries.push({
        at: Number.isFinite(us) ? new Date(us / 1000).toISOString() : null,
        message: raw.MESSAGE,
        unit: raw._SYSTEMD_UNIT ?? raw._SYSTEMD_USER_UNIT ?? null,
      });
    } catch {
      // skip
    }
  }
  return { ok: true, entries, limited: LIMITED.test(stderr) };
}

export function defaultJournal({ run = runJournalctl, lastCommand = defaultLast } = {}) {
  return {
    bootTail(bootId) {
      return run(["-b", journalBootArg(bootId), "-n", "200"]);
    },
    kernelOom(bootId) {
      const pattern = "Out of memory|oom-kill|Killed process";
      const first = run(["-k", "-b", journalBootArg(bootId), "--grep", pattern]);
      // Built without pattern matching: fetch the tail and filter here.
      if (!first.ok && /pattern|grep/i.test(first.error)) {
        const all = run(["-k", "-b", journalBootArg(bootId), "-n", "50000"]);
        if (!all.ok) return all;
        const re = new RegExp(pattern, "i");
        return { ...all, entries: all.entries.filter((e) => re.test(e.message)) };
      }
      return first;
    },
    oomd(bootId) {
      return run(["-b", journalBootArg(bootId), "-u", "systemd-oomd"]);
    },
    last: lastCommand,
  };
}

function defaultLast() {
  const r = spawnSync("last", ["-x", "-F", "shutdown", "reboot"], { encoding: "utf8", timeout: 10_000 });
  if (r.error || r.status !== 0) return { ok: false, error: r.error?.message || String(r.stderr || "").trim() || "last failed" };
  return { ok: true, text: String(r.stdout || "") };
}

// ---------------------------------------------------------------------------
// Evidence

/**
 * How the boot before this one ended, from wtmp: the newest line is the
 * current boot; a `shutdown` record right below it means the previous boot
 * stopped in order, a second `reboot` means it never recorded a stop.
 */
export function parseLast(text) {
  const lines = String(text).split("\n").map((l) => l.trim()).filter((l) => /^(reboot|shutdown)\b/.test(l));
  if (lines.length < 2 || !/^reboot\b/.test(lines[0])) return null;
  if (/^shutdown\b/.test(lines[1])) return "clean";
  if (/^reboot\b/.test(lines[1])) return "unclean";
  return null;
}

function shutdownEvidence({ journal, previousBootId, gaps }) {
  const tail = journal.bootTail(previousBootId);
  if (tail.ok && tail.entries.length) {
    const orderly = tail.entries.some((e) => ORDERLY.test(e.message));
    const end = tail.entries.at(-1)?.at ?? null;
    if (tail.limited) {
      gaps.push("system journal not readable (user not in systemd-journal/adm); judged from the user journal alone");
      if (orderly) {
        gaps.push("a user manager that exited at logout also reads as a clean stop");
        return { kind: "clean", source: "journal-user", last_entry_at: end };
      }
      return { kind: "unknown", source: "journal-user", last_entry_at: end };
    }
    return { kind: orderly ? "clean" : "unclean", source: "journal", last_entry_at: end };
  }
  if (!tail.ok) gaps.push(`previous boot not in the journal: ${tail.error}`);
  else gaps.push("journal holds no entries for the previous boot");
  const last = journal.last?.();
  if (last?.ok) {
    const kind = parseLast(last.text);
    if (kind) return { kind, source: "wtmp", last_entry_at: null };
    gaps.push("wtmp has no record of the previous boot's end");
  } else if (last) {
    gaps.push(`wtmp not readable: ${last.error}`);
  }
  return { kind: "unknown", source: null, last_entry_at: null };
}

/** Kernel OOM victims, one row per killed pid. */
export function parseKernelOom(entries) {
  const byPid = new Map();
  const row = (pid) => {
    if (!byPid.has(pid)) byPid.set(pid, { pid, at: null, process: null, constraint: null, cgroup: null, source: "kernel" });
    return byPid.get(pid);
  };
  for (const e of entries) {
    const memcg = /oom-kill:constraint=([A-Z_]+).*?task_memcg=([^,]*),task=([^,]*),pid=(\d+)/.exec(e.message);
    if (memcg) {
      const r = row(Number(memcg[4]));
      Object.assign(r, { constraint: memcg[1], cgroup: memcg[2] || null, process: memcg[3] });
      r.at ??= e.at;
      continue;
    }
    const killed = /Kill(?:ed)? process (\d+) \(([^)]*)\)/.exec(e.message);
    if (killed) {
      const r = row(Number(killed[1]));
      r.process ??= killed[2];
      r.at ??= e.at;
    }
  }
  return [...byPid.values()];
}

export function parseOomd(entries) {
  const out = [];
  for (const e of entries) {
    const m = /Killed (\S+) due to (memory pressure|memory used|swap)/i.exec(e.message);
    if (m) out.push({ pid: null, at: e.at, process: null, constraint: null, cgroup: m[1], source: "systemd-oomd", cause: m[2] });
  }
  return out;
}

const UNIT_RUN = /team-up-(\d{8}T\d{6}Z-[a-z0-9]+)-[a-z0-9]+\.service/;

/**
 * Tie a victim to a worker: by pid from the last sample, or by the unit name
 * team-up gives sandboxed workers. A matching process name alone is noted but
 * decides nothing; the human's own `claude` has the same name.
 */
function attributeVictims(victims, lastSample) {
  const workers = lastSample?.workers ?? [];
  const comms = new Set(workers.flatMap((w) => w.comms ?? []));
  return victims.map((v) => {
    const byPid = v.pid != null ? workers.find((w) => (w.pids ?? []).includes(v.pid)) : null;
    const byUnit = v.cgroup ? UNIT_RUN.exec(v.cgroup) : null;
    return {
      ...v,
      team_up_run: byPid?.runId ?? byUnit?.[1] ?? null,
      name_match: v.process ? comms.has(v.process) : false,
      // A kill inside a memory ceiling is the ceiling working, not the machine
      // running out.
      contained: v.constraint === "CONSTRAINT_MEMCG",
    };
  });
}

function oomEvidence({ journal, previousBootId, lastSample, gaps }) {
  const victims = [];
  const kernel = journal.kernelOom(previousBootId);
  if (!kernel.ok) gaps.push(`kernel log not readable: ${kernel.error}`);
  else if (kernel.limited) gaps.push("kernel log not readable: user not in systemd-journal/adm");
  else victims.push(...parseKernelOom(kernel.entries));
  const oomd = journal.oomd(previousBootId);
  if (oomd.ok && !oomd.limited) victims.push(...parseOomd(oomd.entries));
  return attributeVictims(victims, lastSample);
}

function round(value, digits = 3) {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

function availableRatio(sample) {
  const m = sample.mem;
  return m?.MemTotal ? m.MemAvailable / m.MemTotal : null;
}

function teamUpShare(sample) {
  const m = sample.mem;
  const used = m ? m.MemTotal - m.MemAvailable : 0;
  if (!used || typeof sample.team_up_rss_kb !== "number") return null;
  // Summed RSS counts shared pages once per process, so it can exceed what the
  // kernel calls used. Capped: "all of it" is the most the share can say.
  return Math.min(1, sample.team_up_rss_kb / used);
}

function swapUsed(sample) {
  const m = sample.mem;
  return m ? m.SwapTotal - m.SwapFree : null;
}

/** What the last ten minutes of samples before the end of a boot show. */
export function summarizeWindow(samples, { bootEnd = null } = {}) {
  if (!samples.length) return null;
  const last = samples.at(-1);
  const from = new Date(Date.parse(last.at) - WINDOW_MS).toISOString();
  const window = samples.filter((s) => s.at >= from);
  let tightest = null;
  for (const s of window) {
    const ratio = availableRatio(s);
    if (ratio !== null && (tightest === null || ratio < availableRatio(tightest))) tightest = s;
  }
  const psi = (kind) => {
    const values = window.map((s) => s.psi?.memory?.[kind]?.avg10).filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
  };
  const swapFirst = swapUsed(window[0]);
  const swapLast = swapUsed(last);
  const swapTotal = last.mem?.SwapTotal ?? 0;
  let swapTrend = null;
  if (swapFirst !== null && swapLast !== null) {
    const delta = swapLast - swapFirst;
    swapTrend = swapTotal === 0 ? "none"
      : delta > swapTotal * 0.01 ? "rising"
        : delta < -swapTotal * 0.01 ? "falling" : "flat";
  }
  const gap = bootEnd ? (Date.parse(bootEnd) - Date.parse(last.at)) / 1000 : null;
  return {
    from: window[0].at,
    to: last.at,
    samples: window.length,
    min_mem_available_ratio: round(tightest ? availableRatio(tightest) : null),
    max_psi_memory_full_avg10: psi("full"),
    max_psi_memory_some_avg10: psi("some"),
    swap_used_kb_last: swapLast,
    swap_trend: swapTrend,
    team_up_share_last: round(teamUpShare(last), 2),
    team_up_share_at_tightest: round(tightest ? teamUpShare(tightest) : null, 2),
    workers_last: (last.workers ?? []).length,
    workers_max: Math.max(...window.map((s) => (s.workers ?? []).length)),
    workers_at_last: (last.workers ?? []).map((w) => ({
      runId: w.runId, role: w.role ?? null, cli: w.cli ?? null, rss_kb: w.rss_kb ?? null,
    })),
    sampler_gap_s: gap !== null && Number.isFinite(gap) ? Math.round(gap) : null,
  };
}

/**
 * The verdict and the sentences that justify it.
 *
 * The share that counts is team-up's at the tightest moment of the window, not
 * at the last sample: workers the OOM killer already took are gone from the
 * last sample, and that is when the machine looks least like team-up's doing.
 */
export function decideVerdict({ shutdown, oom, window, thresholds = DEFAULT_THRESHOLDS }) {
  const reasons = [];
  if (shutdown.kind === "clean") {
    reasons.push(`orderly shutdown found (${shutdown.source})`);
    return { verdict: "clean_shutdown", reasons };
  }
  reasons.push(shutdown.kind === "unclean"
    ? `no orderly shutdown recorded (${shutdown.source})`
    : "how the previous boot ended is not known");

  const systemOom = oom.filter((v) => !v.contained);
  const signals = [];
  if (systemOom.length) signals.push(`${systemOom.length} OOM kill(s)`);
  const ratio = window?.min_mem_available_ratio;
  if (ratio != null && ratio < thresholds.mem_available_ratio) {
    signals.push(`MemAvailable fell to ${(ratio * 100).toFixed(1)}%`);
  }
  const psiFull = window?.max_psi_memory_full_avg10;
  if (psiFull != null && psiFull > thresholds.psi_full_avg10) {
    signals.push(`memory pressure full avg10 reached ${psiFull}`);
  }
  if (!signals.length) {
    reasons.push(window ? "no sign of memory exhaustion in the last samples" : "no samples from the previous boot's end");
    return { verdict: "unknown", reasons };
  }
  reasons.push(`memory exhaustion: ${signals.join(", ")}`);

  const victims = systemOom.filter((v) => v.team_up_run);
  const share = window?.team_up_share_at_tightest;
  if (victims.length) {
    reasons.push(`OOM victim(s) belonged to team-up: ${[...new Set(victims.map((v) => v.team_up_run))].join(", ")}`);
    return { verdict: "team_up_suspected", reasons };
  }
  if (share != null && share >= thresholds.team_up_share) {
    reasons.push(`team-up held ${Math.round(share * 100)}% of used memory at the tightest sample`);
    return { verdict: "team_up_suspected", reasons };
  }
  if (share != null) {
    reasons.push(`team-up held only ${Math.round(share * 100)}% of used memory at the tightest sample`);
    return { verdict: "other_cause", reasons };
  }
  reasons.push("team-up's share of memory is not known");
  return { verdict: "unknown", reasons };
}

export function restartReportPath(logDir, bootId) {
  return path.join(logDir, `restart-${bootId}.json`);
}

function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Did this machine restart since the telemetry last ran, and was it team-up?
 *
 * Returns null when there is no telemetry from an earlier boot: either the
 * sampler never ran before this boot or its files have aged out, and in both
 * cases there is nothing to judge. Written once per boot; a second call
 * returns the stored report unless `refresh` is set.
 */
export function analyzeRestart({
  telemetryDir,
  logDir,
  procRoot = "/proc",
  journal = defaultJournal(),
  thresholds = DEFAULT_THRESHOLDS,
  now = new Date(),
  write = true,
  refresh = false,
} = {}) {
  const bootId = readBootId(procRoot);
  if (!bootId) return null;
  const file = restartReportPath(logDir, bootId);
  if (!refresh && fs.existsSync(file)) {
    try {
      return { ...JSON.parse(fs.readFileSync(file, "utf8")), path: file, cached: true };
    } catch {
      // unreadable: recompute below
    }
  }

  const earlier = readSamples({ dir: telemetryDir }).filter((s) => s.boot_id && s.boot_id !== bootId);
  if (!earlier.length) return null;
  const previousBootId = earlier.at(-1).boot_id;
  const samples = earlier.filter((s) => s.boot_id === previousBootId);
  const lastSample = samples.at(-1);

  const gaps = [];
  const shutdown = shutdownEvidence({ journal, previousBootId, gaps });
  const oom = oomEvidence({ journal, previousBootId, lastSample, gaps });
  const window = summarizeWindow(samples, { bootEnd: shutdown.source === "journal" ? shutdown.last_entry_at : null });
  if (window?.sampler_gap_s != null && window.sampler_gap_s > 120) {
    gaps.push(`sampler stopped ${window.sampler_gap_s}s before the boot ended; the machine may have stalled`);
  }
  const applied = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const { verdict, reasons } = decideVerdict({ shutdown, oom, window, thresholds: applied });

  const report = {
    schema: REPORT_SCHEMA,
    created_at: now.toISOString(),
    boot_id: bootId,
    previous_boot_id: previousBootId,
    verdict,
    reasons,
    shutdown,
    oom,
    window,
    thresholds: applied,
    evidence_gaps: gaps,
  };
  if (write) writeReport(file, report);
  return { ...report, path: write ? file : null, cached: false };
}

/** Restart reports newer than `days`, newest first. */
export function listRestartReports({ logDir, now = new Date(), days = 7 } = {}) {
  let names;
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return [];
  }
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const out = [];
  for (const name of names) {
    if (!/^restart-.+\.json$/.test(name)) continue;
    try {
      const report = JSON.parse(fs.readFileSync(path.join(logDir, name), "utf8"));
      if (report.schema !== REPORT_SCHEMA) continue;
      if (Date.parse(report.created_at) < cutoff) continue;
      out.push({ ...report, path: path.join(logDir, name) });
    } catch {
      // skip unreadable
    }
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** A few lines for a terminal; the file holds the rest. */
export function formatRestartReport(report) {
  const lines = [`restart: ${report.verdict} (previous boot ${report.previous_boot_id})`];
  for (const reason of report.reasons ?? []) lines.push(`  - ${reason}`);
  const w = report.window;
  if (w) {
    lines.push(`  workers at last sample: ${w.workers_last} (max ${w.workers_max} in the last ${w.samples} samples)`);
  }
  for (const gap of report.evidence_gaps ?? []) lines.push(`  gap: ${gap}`);
  if (report.path) lines.push(`  report: ${report.path}`);
  return lines;
}
