#!/usr/bin/env node
// Summarize shadow/control triage outcomes from run STATE.json files only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runsPath } from "../src/paths.mjs";

const TIERS = ["low", "medium", "high", "frontier"];
const HIGH_TIERS = new Set(["high", "frontier"]);
const LOW_TIERS = new Set(["low", "medium"]);

export function loadRunStates(root = runsPath()) {
  if (!fs.existsSync(root)) return [];
  const states = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      states.push(JSON.parse(fs.readFileSync(path.join(root, entry.name, "STATE.json"), "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  return states;
}

function cohort() {
  return { runs: 0, done: 0, failed: 0, escalated: 0 };
}

/** Bad outcome: failed, waiting_human, or recorded pass-to/handoff escalation. */
export function isBadOutcome(state) {
  if (state.status === "failed") return true;
  if (state.status === "waiting_human") return true;
  if (state.escalations?.length) return true;
  return false;
}

function observeOutcome(target, state) {
  target.runs++;
  if (state.status === "done") target.done++;
  if (state.status === "failed") target.failed++;
  if (state.status === "waiting_human" || state.escalations?.length) target.escalated++;
}

function badRate(n, bad) {
  return n > 0 ? bad / n : 0;
}

function tierGroup(tier) {
  if (HIGH_TIERS.has(tier)) return "high";
  if (LOW_TIERS.has(tier)) return "low";
  return null;
}

export function buildTriageShadowReport(states) {
  const roles = {};
  for (const state of states) {
    const decision = state?.triage;
    if (!decision || decision.applied === true) continue;
    const role = state.role || "unknown";
    const row = roles[role] ??= {
      runs: 0,
      jev: 0,
      fallback: 0,
      wouldDowngrade: 0,
      wouldUpgrade: 0,
      sameTier: 0,
      unknownWorkerTier: 0,
      highTier: cohort(),
      lowerTier: cohort(),
    };
    row.runs++;
    if (decision.source !== "jev" || !decision.profile?.tier) {
      row.fallback++;
      continue;
    }
    row.jev++;
    const proposed = TIERS.indexOf(decision.profile.tier);
    const actual = TIERS.indexOf(state.worker?.tier);
    if (proposed < 0) {
      row.unknownWorkerTier++;
      continue;
    }
    if (actual < 0) row.unknownWorkerTier++;
    else if (proposed < actual) row.wouldDowngrade++;
    else if (proposed > actual) row.wouldUpgrade++;
    else row.sameTier++;
    observeOutcome(proposed >= 2 ? row.highTier : row.lowerTier, state);
  }
  return {
    roles,
    notes: [
      "Counts include shadow runs and active-mode control runs; applied triage runs are excluded.",
      "Failure is status=failed. Escalation is a recorded handoff/pass-to event or status=waiting_human.",
      "Legacy runs without worker.tier cannot contribute to downgrade/upgrade counts.",
    ],
  };
}

export function buildTriageVerdictReport(states, {
  minRuns = 50,
  minGroup = 10,
  minDiff = 0.10,
  now = new Date(),
} = {}) {
  const shadowHigh = { n: 0, bad: 0 };
  const shadowLow = { n: 0, bad: 0 };
  const applied = { n: 0, bad: 0 };
  const control = { n: 0, bad: 0 };
  const fallback_reasons = {};

  for (const state of states) {
    const triage = state?.triage;
    if (!triage) continue;

    const reason = triage.fallback_reason;
    if (reason) {
      fallback_reasons[reason] = (fallback_reasons[reason] ?? 0) + 1;
    }

    if (triage.applied === true) {
      applied.n++;
      if (isBadOutcome(state)) applied.bad++;
      continue;
    }

    if (triage.source === "jev" && triage.profile?.tier) {
      const group = tierGroup(triage.profile.tier);
      if (group === "high") {
        shadowHigh.n++;
        if (isBadOutcome(state)) shadowHigh.bad++;
      } else if (group === "low") {
        shadowLow.n++;
        if (isBadOutcome(state)) shadowLow.bad++;
      }
      control.n++;
      if (isBadOutcome(state)) control.bad++;
    }
  }

  const shadowTotal = shadowHigh.n + shadowLow.n;
  const highRate = badRate(shadowHigh.n, shadowHigh.bad);
  const lowRate = badRate(shadowLow.n, shadowLow.bad);
  const diff = highRate - lowRate;

  let shadowVerdict;
  if (shadowTotal < minRuns || shadowHigh.n < minGroup || shadowLow.n < minGroup) {
    shadowVerdict = "COLLECTING";
  } else if (diff >= minDiff) {
    shadowVerdict = "DECISION_DUE";
  } else {
    shadowVerdict = "STOP";
  }

  const appliedRate = badRate(applied.n, applied.bad);
  const controlRate = badRate(control.n, control.bad);
  const activeDiff = appliedRate - controlRate;

  let activeVerdict;
  if (applied.n < minGroup || control.n < minGroup) {
    activeVerdict = "INSUFFICIENT";
  } else if (activeDiff >= minDiff) {
    activeVerdict = "REGRESSION";
  } else {
    activeVerdict = "OK";
  }

  const per_role = buildTriageShadowReport(states).roles;

  return {
    generated_at: now.toISOString(),
    shadow: {
      verdict: shadowVerdict,
      total: shadowTotal,
      groups: {
        high: { n: shadowHigh.n, bad: shadowHigh.bad },
        low: { n: shadowLow.n, bad: shadowLow.bad },
      },
      diff,
    },
    active: {
      verdict: activeVerdict,
      applied,
      control,
    },
    fallback_reasons,
    per_role,
  };
}

function formatPct(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatMdReport(report) {
  const lines = [];
  const { shadow, active, fallback_reasons } = report;

  lines.push(`**Shadow verdict: ${shadow.verdict}**`);
  lines.push(
    `JEV shadow runs: ${shadow.total} (high/frontier ${shadow.groups.high.n}, low/medium ${shadow.groups.low.n})`,
  );
  if (shadow.total > 0) {
    const highRate = badRate(shadow.groups.high.n, shadow.groups.high.bad);
    const lowRate = badRate(shadow.groups.low.n, shadow.groups.low.bad);
    lines.push(
      `Bad rates: high ${formatPct(highRate)} (${shadow.groups.high.bad}/${shadow.groups.high.n}), `
      + `low ${formatPct(lowRate)} (${shadow.groups.low.bad}/${shadow.groups.low.n}), diff ${formatPct(shadow.diff)}`,
    );
  }

  lines.push("");
  lines.push(`**Active verdict: ${active.verdict}**`);
  lines.push(
    `Applied ${active.applied.n} (${active.applied.bad} bad), control ${active.control.n} (${active.control.bad} bad)`,
  );

  const fallbackEntries = Object.entries(fallback_reasons).sort(([a], [b]) => a.localeCompare(b));
  if (fallbackEntries.length) {
    lines.push("");
    lines.push("Fallback reasons:");
    for (const [reason, count] of fallbackEntries) {
      lines.push(`- ${reason}: ${count}`);
    }
  }

  const roleEntries = Object.entries(report.per_role).sort(([a], [b]) => a.localeCompare(b));
  if (roleEntries.length) {
    lines.push("");
    lines.push("Per role (shadow/control):");
    for (const [role, row] of roleEntries) {
      lines.push(
        `- ${role}: ${row.runs} runs, JEV ${row.jev}, would downgrade ${row.wouldDowngrade}/upgrade ${row.wouldUpgrade}`,
      );
    }
  }

  return lines.join("\n").slice(0, 3500);
}

export function parseReportArgs(argv) {
  const args = argv.slice(2);
  let runsDir;
  let format = "md";
  let minRuns = 50;
  let minGroup = 10;
  let minDiff = 0.10;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--runs-dir") {
      runsDir = args[++i];
    } else if (arg === "--json" || arg === "--format") {
      const next = args[i + 1];
      if (arg === "--json") {
        format = "json";
      } else if (next === "md" || next === "json") {
        format = next;
        i++;
      } else {
        return { error: "usage: --format md|json" };
      }
    } else if (arg === "--min-runs") {
      minRuns = Number(args[++i]);
    } else if (arg === "--min-group") {
      minGroup = Number(args[++i]);
    } else if (arg === "--min-diff") {
      minDiff = Number(args[++i]);
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }

  return {
    runsDir: runsDir ?? runsPath(),
    format,
    minRuns,
    minGroup,
    minDiff,
  };
}

function printLegacyReport(report) {
  for (const [role, row] of Object.entries(report.roles).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`${role}: ${row.runs} runs, ${row.jev} Jev, ${row.fallback} fallback`);
    console.log(`  would downgrade ${row.wouldDowngrade}, upgrade ${row.wouldUpgrade}, same ${row.sameTier}, unknown worker tier ${row.unknownWorkerTier}`);
    for (const [label, bucket] of [["high/frontier", row.highTier], ["low/medium", row.lowerTier]]) {
      console.log(`  ${label}: ${bucket.runs} runs, ${bucket.done} done, ${bucket.failed} failed, ${bucket.escalated} escalated`);
    }
  }
  for (const note of report.notes) console.log(`note: ${note}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseReportArgs(process.argv);
  if (parsed.error) {
    console.error(
      "usage: node scripts/triage-shadow-report.mjs [--runs-dir <dir>] [--format md|json] [--json]"
      + " [--min-runs N] [--min-group N] [--min-diff F]",
    );
    process.exitCode = 1;
  } else {
    const states = loadRunStates(parsed.runsDir);
    const report = buildTriageVerdictReport(states, {
      minRuns: parsed.minRuns,
      minGroup: parsed.minGroup,
      minDiff: parsed.minDiff,
    });
    if (parsed.format === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatMdReport(report));
    }
  }
}

export { printLegacyReport };
