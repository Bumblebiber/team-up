#!/usr/bin/env node
// run-insights.mjs — what the last N hours of team-up runs say, as findings.
//
// Deterministic on purpose: this decides *whether* anything changed, and only
// then does scripts/insights-cron.sh pay a model to judge *what to do*. The
// finding ids are stable so the cron can dedup on their hash.
//
//   node scripts/run-insights.mjs [--since-hours 48] [--out-dir DIR] [--no-doctor]
//
// Without --out-dir the report is printed as JSON. With it, insights-<ts>.json
// and .md land there and the JSON path is printed.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyMailbox, listAllStates, runDir } from "../src/runs/runs.mjs";

const TERMINAL = new Set(["done", "failed", "cancelled"]);

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** One line, no temp paths or pids, so the same cause counts as one reason. */
export function normalizeReason(text) {
  return String(text)
    .split("\n")[0]
    .replace(/\/tmp\/\S+/g, "<tmp>")
    .replace(/\d{4,}/g, "N")
    .trim()
    .slice(0, 100);
}

/**
 * Why a failed run failed. Runs written before STATE carried `failure` still
 * hold the reason somewhere — a legacy field, VERIFICATION.json, or the
 * mailbox the classifier can re-read.
 */
export function failureReason(state, dir = runDir(state.runId)) {
  const direct =
    state.failure?.error ||
    state.last_start_error ||
    state.supervision_failure?.error ||
    state.last_error ||
    state.cleanup?.stale_reason;
  if (direct) return normalizeReason(direct);
  if (readJson(path.join(dir, "mailbox", "VERIFICATION.json"))?.verdict === "fail") {
    return "parent verification failed";
  }
  try {
    const classified = classifyMailbox(state.runId);
    if (classified.error) return normalizeReason(classified.error);
    // The worker said done; someone overrode it with set-status and no --reason.
    if (classified.status === "done") return "set-status failed over a done mailbox, no reason";
  } catch {
    /* unreadable mailbox falls through to unknown */
  }
  return "unknown";
}

export function observationStats(dir) {
  const stats = { stalls: 0, judgeCalls: 0, escalations: 0 };
  for (const line of (readText(path.join(dir, "mailbox", "OBSERVATION.log")) || "").split("\n")) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.kind === "stall_detected") stats.stalls++;
    if (ev.kind === "judge_call") stats.judgeCalls++;
    if (ev.kind === "decision" && ev.action === "escalate") stats.escalations++;
  }
  return stats;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function bucket(map, key) {
  return (map[key] ??= { runs: 0, done: 0, failed: 0, cancelled: 0, waiting_human: 0, minutes: [] });
}

function finishBuckets(map) {
  const out = {};
  for (const [key, b] of Object.entries(map)) {
    const { minutes, ...rest } = b;
    const ended = b.done + b.failed;
    out[key] = { ...rest, failRate: ended ? +(b.failed / ended).toFixed(2) : 0, medianMin: median(minutes) };
  }
  return out;
}

/**
 * @param states   run STATE objects
 * @param runInfo  runId → { reason, obs } (injected so tests need no disk)
 * @param doctor   `team-up doctor` JSON or null
 */
export function buildInsights(states, { now = new Date(), sinceHours = 48, runInfo, doctor = null } = {}) {
  const since = new Date(now.getTime() - sinceHours * 3600_000);
  const inWindow = states.filter((s) => s.createdAt && new Date(s.createdAt) >= since);
  const byModel = {};
  const byRole = {};
  const reasons = {};
  const observer = { stalls: 0, judgeCalls: 0, escalations: 0 };
  let doneWithOutcome = 0;

  for (const s of inWindow) {
    const info = runInfo(s);
    const buckets = [bucket(byModel, `${s.worker?.cli || "?"}:${s.worker?.model || "?"}`), bucket(byRole, s.role || "?")];
    for (const b of buckets) {
      b.runs++;
      if (b[s.status] !== undefined) b[s.status]++;
      if (TERMINAL.has(s.status)) {
        const end = s.finishedAt || s.updatedAt;
        if (end) b.minutes.push(Math.round((new Date(end) - new Date(s.createdAt)) / 60000));
      }
    }
    if (s.status === "failed") reasons[info.reason] = (reasons[info.reason] || 0) + 1;
    if (s.status === "done" && s.outcome?.value) doneWithOutcome++;
    for (const k of Object.keys(observer)) observer[k] += info.obs[k];
  }

  const totals = { runs: inWindow.length };
  for (const s of inWindow) totals[s.status] = (totals[s.status] || 0) + 1;
  const report = {
    schema: "team-up.insights/v1",
    generatedAt: now.toISOString(),
    window: { sinceHours, since: since.toISOString() },
    totals,
    byModel: finishBuckets(byModel),
    byRole: finishBuckets(byRole),
    failureReasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1])),
    outcome: { done: totals.done || 0, recorded: doneWithOutcome },
    observer,
    doctor: doctor ? { counts: doctor.counts } : null,
  };
  report.findings = deriveFindings(report, doctor);
  report.findingsHash = crypto
    .createHash("sha256")
    .update(report.findings.map((f) => f.id).sort().join("\n"))
    .digest("hex");
  return report;
}

// ponytail: fixed thresholds; make them flags once a real run shows they misfire.
export function deriveFindings(report, doctor) {
  const out = [];
  for (const [model, b] of Object.entries(report.byModel)) {
    if (b.done + b.failed >= 3 && b.failRate >= 0.3) {
      out.push({
        id: `fail_rate:${model}`,
        severity: b.failRate >= 0.5 ? "high" : "medium",
        text: `${model}: ${b.failed} of ${b.done + b.failed} finished runs failed (${Math.round(b.failRate * 100)}%)`,
      });
    }
  }
  for (const [reason, n] of Object.entries(report.failureReasons)) {
    if (reason === "unknown") {
      out.push({ id: "failure_reason_unknown", severity: "low", text: `${n} failed run(s) carry no recoverable reason` });
    } else if (n >= 2) {
      out.push({ id: `recurring_failure:${reason}`, severity: "medium", text: `${n}× failed with: ${reason}` });
    }
  }
  const { done, recorded } = report.outcome;
  if (done >= 3 && recorded / done < 0.5) {
    out.push({
      id: "outcome_unrecorded",
      severity: "low",
      text: `${recorded} of ${done} done runs have an outcome — \`runs outcome <id> merged|discarded\` is not being called`,
    });
  }
  if (report.observer.escalations >= 3) {
    out.push({ id: "observer_escalations", severity: "medium", text: `observer escalated ${report.observer.escalations}× to a human` });
  }
  for (const f of doctor?.findings || []) {
    if (f.severity === "low") continue;
    out.push({ id: `doctor:${f.kind}:${f.cli || f.id || ""}`, severity: f.severity, text: f.detail || f.kind });
  }
  return out;
}

export function renderMarkdown(r) {
  const lines = [
    `# team-up insights — ${r.generatedAt}`,
    "",
    `Window: last ${r.window.sinceHours}h · runs: ${r.totals.runs} · ${["done", "failed", "cancelled", "waiting_human"].map((k) => `${k} ${r.totals[k] || 0}`).join(" · ")}`,
    "",
    "## Findings",
    "",
    ...(r.findings.length ? r.findings.map((f) => `- **${f.severity}** ${f.new ? "🆕 " : ""}${f.text} \`${f.id}\``) : ["None."]),
    "",
    "## By model",
    "",
    "| model | runs | done | failed | cancelled | fail rate | median min |",
    "|---|---|---|---|---|---|---|",
    ...Object.entries(r.byModel).map(([k, b]) => `| ${k} | ${b.runs} | ${b.done} | ${b.failed} | ${b.cancelled} | ${b.failRate} | ${b.medianMin ?? "-"} |`),
    "",
    "## Failure reasons",
    "",
    ...(Object.keys(r.failureReasons).length ? Object.entries(r.failureReasons).map(([k, n]) => `- ${n}× ${k}`) : ["None."]),
    "",
    `Outcome recorded on ${r.outcome.recorded}/${r.outcome.done} done runs. Observer: ${r.observer.stalls} stalls, ${r.observer.judgeCalls} judge calls, ${r.observer.escalations} escalations.`,
    "",
  ];
  return lines.join("\n");
}

function runDoctor() {
  try {
    const bin = fileURLToPath(new URL("../bin/team-up.mjs", import.meta.url));
    return JSON.parse(execFileSync(process.execPath, [bin, "doctor"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch (e) {
    // doctor exits non-zero when it has findings; its stdout is still the report.
    try {
      return JSON.parse(e.stdout);
    } catch {
      return null;
    }
  }
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const sinceHours = Number(arg("--since-hours") || 48);
  const outDir = arg("--out-dir");
  const report = buildInsights(listAllStates({ onCorrupt: () => {} }), {
    sinceHours,
    doctor: argv.includes("--no-doctor") ? null : runDoctor(),
    runInfo: (s) => {
      const dir = runDir(s.runId);
      return { reason: s.status === "failed" ? failureReason(s, dir) : null, obs: observationStats(dir) };
    },
  });
  if (!outDir) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const previous = fs.readdirSync(outDir).filter((f) => /^insights-.*\.json$/.test(f)).sort().pop();
  const seen = new Set((readJson(path.join(outDir, previous || "-"))?.findings || []).map((f) => f.id));
  for (const f of report.findings) f.new = !seen.has(f.id);
  const base = path.join(outDir, `insights-${report.generatedAt.replace(/[:.]/g, "-")}`);
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(`${base}.md`, renderMarkdown(report));
  process.stdout.write(`${base}.json\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
