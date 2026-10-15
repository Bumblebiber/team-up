#!/usr/bin/env node
// review-effectiveness.mjs — measurable comparisons for capsule Revan vs plain reviewers.
//
//   node scripts/review-effectiveness.mjs [--runs-dir DIR] [--fixtures DIR] [--json]
//
// Reads historical team-up runs (default ~/.team-up/runs), cohort lists and
// benchmarks from test/fixtures/review-effectiveness/, and prints a report with
// n, method, and effect size per comparison.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { estimatePromptTokenContribution } from "../src/capabilities/mcp-schema.mjs";
import { countedStates, STATS_SINCE } from "./run-insights.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = path.join(__dirname, "../test/fixtures/review-effectiveness");

const SEVERITY_RANK = { high: 3, medium: 2, low: 1, info: 0 };

export function resolveRunDir(runsRoot, suffix) {
  const match = fs.readdirSync(runsRoot).find((d) => d.endsWith(`-${suffix}`));
  if (!match) return null;
  return path.join(runsRoot, match);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** New review findings only — not fix-verification rows or status tables. */
export function extractFindings({ runDir, state }) {
  const resultJson = readJson(path.join(runDir, "mailbox", "RESULT.json"));
  if (resultJson?.schema === "team-up.result/v1") {
    const findings = [];
    for (const f of resultJson.spec_findings ?? []) {
      findings.push({
        id: f.id,
        severity: String(f.severity ?? "info").toLowerCase(),
        axis: "spec",
        kind: "new",
      });
    }
    for (const f of resultJson.standards_findings ?? []) {
      const sev = f.kind === "judgement_call" ? "info" : String(f.severity ?? "info").toLowerCase();
      findings.push({ id: f.id, severity: sev, axis: "standards", kind: "new" });
    }
    return findings;
  }

  const md = readText(path.join(runDir, "mailbox", "RESULT.md"));
  if (!md) return [];

  const findings = [];
  const sections = md.split(/^##\s+/m);
  const body =
    sections.find((s) => /^2\.\s*Findings/m.test(s) || /^2\.\s*New findings/m.test(s)) ??
    sections.at(-1) ??
    md;
  const re = /^###\s+([A-Za-z0-9]+-\d+)\s*:?\s*(?:—\s*)?(HIGH|MEDIUM|LOW|INFO)/gim;
  let m;
  while ((m = re.exec(body))) {
    findings.push({
      id: m[1],
      severity: m[2].toLowerCase(),
      axis: "review",
      kind: "new",
    });
  }
  return findings;
}

export function isActionableFinding(f) {
  return SEVERITY_RANK[f.severity] >= SEVERITY_RANK.medium;
}

export function resolveFixRepo(state) {
  const cwd = state.cwd || state.project;
  if (state.project === "P0079" || (cwd && String(cwd).includes("ultratodo"))) {
    const main = path.join(process.env.HOME || "/home/bbbee", "projects/ultratodo");
    if (fs.existsSync(path.join(main, ".git"))) return main;
  }
  if (cwd && fs.existsSync(path.join(cwd, ".git"))) return cwd;
  return null;
}

export function gitFixedFindingIds(repoDir, findingIds, { sinceCommit = null } = {}) {
  if (!repoDir || !fs.existsSync(path.join(repoDir, ".git"))) return new Set();
  const args = ["log", "--oneline", "--since=2026-09-28"];
  if (sinceCommit) args.push(`${sinceCommit}..HEAD`);
  let log = "";
  try {
    log = execFileSync("git", args, { cwd: repoDir, encoding: "utf8", maxBuffer: 4_000_000 });
  } catch {
    return new Set();
  }
  const fixed = new Set();
  for (const id of findingIds) {
    const re = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (log.split("\n").some((line) => re.test(line))) fixed.add(id);
  }
  return fixed;
}

export function summarizeRun({ runDir, state, overrides = {} }) {
  const findings = extractFindings({ runDir, state });
  const actionable = findings.filter(isActionableFinding);
  const repoDir = resolveFixRepo(state);
  const gitFixed = gitFixedFindingIds(repoDir, actionable.map((f) => f.id), {
    sinceCommit: state.base_commit,
  });

  let confirmed = 0;
  let fixed = 0;
  for (const f of actionable) {
    const o = overrides[f.id];
    const isConfirmed = o?.confirmed ?? true;
    const isFixed = o?.fixed ?? gitFixed.has(f.id);
    if (isConfirmed) confirmed++;
    if (isConfirmed && isFixed) fixed++;
  }

  return {
    runId: state.runId,
    role: state.role,
    findings: findings.length,
    actionable: actionable.length,
    confirmed,
    fixed,
    specialist: state.specialist?.id ?? null,
  };
}

export function meanAndSd(values) {
  if (!values.length) return { n: 0, mean: null, sd: null };
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n < 2 ? 0 : Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd };
}

export function cohensD(a, b) {
  if (!a.n || !b.n || a.mean == null || b.mean == null) return null;
  const pooled = Math.sqrt(
    ((a.n - 1) * a.sd ** 2 + (b.n - 1) * b.sd ** 2) / Math.max(1, a.n + b.n - 2),
  );
  if (!pooled) return 0;
  return +((a.mean - b.mean) / pooled).toFixed(3);
}

export function analyzeQualityAb({ runsRoot, cohorts, overridesByRun = {} }) {
  const capsuleSuffixes = cohorts.capsule_revan_suffixes ?? [];
  const plainSuffixes = cohorts.plain_reviewer_suffixes ?? [];
  const capsuleRuns = [];
  const plainRuns = [];

  for (const suffix of capsuleSuffixes) {
    const runDir = resolveRunDir(runsRoot, suffix);
    if (!runDir) continue;
    const state = readJson(path.join(runDir, "STATE.json"));
    if (!state) continue;
    capsuleRuns.push(summarizeRun({ runDir, state, overrides: overridesByRun[state.runId] ?? {} }));
  }
  for (const suffix of plainSuffixes) {
    const runDir = resolveRunDir(runsRoot, suffix);
    if (!runDir) continue;
    const state = readJson(path.join(runDir, "STATE.json"));
    if (!state) continue;
    plainRuns.push(summarizeRun({ runDir, state, overrides: overridesByRun[state.runId] ?? {} }));
  }

  const capFindings = meanAndSd(capsuleRuns.map((r) => r.findings));
  const plainFindings = meanAndSd(plainRuns.map((r) => r.findings));
  const capConfirmed = meanAndSd(capsuleRuns.map((r) => r.confirmed));
  const plainConfirmed = meanAndSd(plainRuns.map((r) => r.confirmed));
  const capFixed = meanAndSd(capsuleRuns.map((r) => r.fixed));
  const plainFixed = meanAndSd(plainRuns.map((r) => r.fixed));

  const capFixRate = capConfirmed.mean
    ? capsuleRuns.reduce((s, r) => s + (r.confirmed ? r.fixed / r.confirmed : 0), 0) / capsuleRuns.length
    : null;
  const plainFixRate = plainConfirmed.mean
    ? plainRuns.reduce((s, r) => s + (r.confirmed ? r.fixed / r.confirmed : 0), 0) / plainRuns.length
    : null;

  return {
    comparison: "capsule_revan_vs_plain_reviewer",
    method: "historical_run_mailbox_results",
    capsule: { runs: capsuleRuns, findings: capFindings, confirmed: capConfirmed, fixed: capFixed, fixRate: capFixRate },
    plain: { runs: plainRuns, findings: plainFindings, confirmed: plainConfirmed, fixed: plainFixed, fixRate: plainFixRate },
    effect_size: {
      findings_count_cohens_d: cohensD(capFindings, plainFindings),
      confirmed_cohens_d: cohensD(capConfirmed, plainConfirmed),
      fix_rate_delta: capFixRate != null && plainFixRate != null ? +(capFixRate - plainFixRate).toFixed(3) : null,
    },
    interpretation:
      capFindings.mean != null && plainFindings.mean != null
        ? capFindings.mean < plainFindings.mean
          ? "capsule reports fewer findings per run on average"
          : capFindings.mean > plainFindings.mean
            ? "capsule reports more findings per run on average"
            : "same mean finding count"
        : "insufficient data",
  };
}

export function analyzePickSkips(states = countedStates()) {
  let withPicks = 0;
  let skippedHead = 0;
  const examples = [];
  for (const s of states) {
    const pick = s.picks?.[0];
    if (!pick) continue;
    withPicks++;
    if (pick.skipped?.length) {
      skippedHead++;
      if (examples.length < 5) {
        examples.push({
          runId: s.runId,
          role: s.role,
          chosen: `${pick.cli}:${pick.model}`,
          skipped: pick.skipped.map((x) => `${x.cli ?? "?"}:${x.model ?? "?"} (${x.reason})`),
        });
      }
    }
  }
  return {
    comparison: "pick_skipped_chain_head",
    method: "STATE.picks since STATS_SINCE",
    stats_since: STATS_SINCE,
    n_dispatches_with_picks: withPicks,
    n_skipped_head: skippedHead,
    rate: withPicks ? +(skippedHead / withPicks).toFixed(4) : null,
    examples,
  };
}

export function measureCapsuleMaterializedTokens(runDir) {
  const eff = readJson(path.join(runDir, "EFFECTIVE_CAPABILITIES.json"));
  const promptBytes = (readText(path.join(runDir, "mailbox", "PROMPT.md")) ?? "").length;
  const promptEst = estimatePromptTokenContribution(promptBytes);
  const capsuleMaterialized = eff?.totals?.estimated_prompt_token_contribution ?? 0;
  return {
    runId: path.basename(runDir),
    capsule_materialized_tokens: capsuleMaterialized + promptEst.estimated_prompt_token_contribution,
    method: "utf8_bytes_div_4_ceil_on_materialized_capsule_plus_prompt",
    note: "Lower bound; excludes Claude host tool registry and system prompt.",
  };
}

export function estimateNativeBaselineTokens(baseline, promptBytes) {
  const promptEst = estimatePromptTokenContribution(promptBytes);
  return {
    estimated_tokens: (baseline.estimated_fixed_overhead_tokens ?? 0) + promptEst.estimated_prompt_token_contribution,
    method: baseline.prompt_token_estimate_method ?? "utf8_bytes_div_4_ceil",
  };
}

export function analyzeStartContext({ benchmarks, nativeBaseline, runsRoot, cohorts }) {
  const capSamples = benchmarks.capsule_specialist?.tokens ?? [];
  const capBench = meanAndSd(capSamples);
  const plainMean = benchmarks.plain_role_dispatch?.mean_tokens ?? null;

  const materialized = [];
  for (const suffix of cohorts.capsule_revan_suffixes ?? []) {
    const runDir = resolveRunDir(runsRoot, suffix);
    if (runDir) materialized.push(measureCapsuleMaterializedTokens(runDir));
  }
  const matStats = meanAndSd(materialized.map((m) => m.capsule_materialized_tokens));

  const promptBytes = 4700;
  const nativeEst = estimateNativeBaselineTokens(nativeBaseline, promptBytes);

  return {
    comparison: "first_turn_start_context_tokens",
    method: benchmarks.capsule_specialist?.method ?? "measured_api_usage",
    capsule_measured: { ...capBench, median: capSamples.length ? capSamples.sort((a, b) => a - b)[Math.floor(capSamples.length / 2)] : null },
    plain_dispatch_measured: {
      n: benchmarks.plain_role_dispatch?.n ?? 0,
      mean: plainMean,
      method: benchmarks.plain_role_dispatch?.method,
    },
    ratio_plain_to_capsule: plainMean && capBench.mean ? +(plainMean / capBench.mean).toFixed(2) : null,
    capsule_materialized_lower_bound: matStats,
    native_baseline_estimate: {
      n: 1,
      mean: nativeEst.estimated_tokens,
      method: nativeEst.method,
      config: "test/fixtures/review-effectiveness/native-baseline-agent.json",
    },
    cross_vendor: benchmarks.cross_vendor_review ?? { status: "not_run" },
  };
}

export function buildReport({ runsRoot, fixturesDir = DEFAULT_FIXTURES } = {}) {
  const cohorts = readJson(path.join(fixturesDir, "cohorts.json")) ?? {};
  const benchmarks = readJson(path.join(fixturesDir, "first-turn-benchmarks.json")) ?? {};
  const nativeBaseline = readJson(path.join(fixturesDir, "native-baseline-agent.json")) ?? {};
  const overrides = readJson(path.join(fixturesDir, "ground-truth-overrides.json")) ?? {};

  return {
    schema: "team-up.review-effectiveness/v1",
    generatedAt: new Date().toISOString(),
    runsRoot,
    quality_ab: analyzeQualityAb({ runsRoot, cohorts, overridesByRun: overrides }),
    pick_skips: analyzePickSkips(),
    start_context: analyzeStartContext({ benchmarks, nativeBaseline, runsRoot, cohorts }),
  };
}

function formatMarkdown(report) {
  const q = report.quality_ab;
  const p = report.pick_skips;
  const s = report.start_context;
  return `# Review effectiveness report

Generated: ${report.generatedAt}

## 1. Quality A/B (capsule Revan vs plain claude-opus reviewer)

Method: ${q.method}. Actionable = severity medium or high.

| cohort | n runs | mean findings | mean confirmed | mean later-fixed | fix rate |
|--------|--------|---------------|----------------|------------------|----------|
| capsule | ${q.capsule.runs.length} | ${q.capsule.findings.mean?.toFixed(2) ?? "—"} | ${q.capsule.confirmed.mean?.toFixed(2) ?? "—"} | ${q.capsule.fixed.mean?.toFixed(2) ?? "—"} | ${q.capsule.fixRate != null ? (q.capsule.fixRate * 100).toFixed(0) + "%" : "—"} |
| plain | ${q.plain.runs.length} | ${q.plain.findings.mean?.toFixed(2) ?? "—"} | ${q.plain.confirmed.mean?.toFixed(2) ?? "—"} | ${q.plain.fixed.mean?.toFixed(2) ?? "—"} | ${q.plain.fixRate != null ? (q.plain.fixRate * 100).toFixed(0) + "%" : "—"} |

Effect size (Cohen's d, findings count): ${q.effect_size.findings_count_cohens_d ?? "—"}. ${q.interpretation}.

Confirmed defects: d=${q.effect_size.confirmed_cohens_d ?? "—"}. Fix-rate delta (capsule − plain): ${q.effect_size.fix_rate_delta ?? "—"}.

## 2. Cross-vendor vs same-vendor review

Status: ${s.cross_vendor?.status ?? "not_run"}. ${s.cross_vendor?.reason ?? ""}

## 3. Start-context tokens

Capsule specialist measured: n=${s.capsule_measured.n}, mean=${s.capsule_measured.mean?.toFixed(0)}, sd=${s.capsule_measured.sd?.toFixed(0)}.
Plain role dispatch: n=${s.plain_dispatch_measured.n}, mean=${s.plain_dispatch_measured.mean}.
Ratio plain/capsule: ${s.ratio_plain_to_capsule ?? "—"}×.

Native tuned baseline estimate (fixture config): ${s.native_baseline_estimate.mean} tokens (${s.native_baseline_estimate.method}).

Materialized capsule lower bound (this host): mean=${s.capsule_materialized_lower_bound.mean?.toFixed(0)} tokens — not comparable to API usage directly.

## 4. Pick skipped chain head (limit gating)

Since ${p.stats_since}: ${p.n_skipped_head} of ${p.n_dispatches_with_picks} dispatches (${(p.rate * 100).toFixed(1)}%) chose a non-head chain cell because of limits.
`;
}

function main() {
  const args = process.argv.slice(2);
  let runsRoot = path.join(process.env.HOME || "/home/bbbee", ".team-up/runs");
  let fixturesDir = DEFAULT_FIXTURES;
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--runs-dir") runsRoot = args[++i];
    else if (args[i] === "--fixtures") fixturesDir = args[++i];
    else if (args[i] === "--json") asJson = true;
  }
  const report = buildReport({ runsRoot, fixturesDir });
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(formatMarkdown(report));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
