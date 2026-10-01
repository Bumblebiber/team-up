import { readSamples } from "./store.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(values, runs) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    runs: runs.size,
    p50_rss_kb: percentile(sorted, 0.5),
    p95_rss_kb: percentile(sorted, 0.95),
    max_rss_kb: sorted.length ? sorted.at(-1) : null,
  };
}

/**
 * RSS per worker over the last `days`: overall, per cli and per role, because a
 * Codex worker and a Claude worker are not the same size. Also the median used
 * memory while no worker ran, which is what the machine needs without team-up.
 */
export function workerFootprint({ dir, days = 7, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const samples = readSamples({ dir, since });
  const groups = { all: { values: [], runs: new Set() }, cli: new Map(), role: new Map() };
  const bucket = (map, key) => {
    const k = key ?? "unknown";
    if (!map.has(k)) map.set(k, { values: [], runs: new Set() });
    return map.get(k);
  };
  const idle = [];
  for (const sample of samples) {
    const workers = sample.workers ?? [];
    if (!workers.length && sample.mem?.MemTotal) {
      idle.push(sample.mem.MemTotal - sample.mem.MemAvailable);
    }
    for (const w of workers) {
      if (!Number.isFinite(w.rss_kb) || w.rss_kb <= 0) continue;
      for (const g of [groups.all, bucket(groups.cli, w.cli), bucket(groups.role, w.role)]) {
        g.values.push(w.rss_kb);
        g.runs.add(w.runId);
      }
    }
  }
  const byKey = (map) => Object.fromEntries(
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, g]) => [k, summarize(g.values, g.runs)]),
  );
  idle.sort((a, b) => a - b);
  return {
    days,
    since,
    samples: samples.length,
    all: summarize(groups.all.values, groups.all.runs),
    by_cli: byKey(groups.cli),
    by_role: byKey(groups.role),
    baseline_used_kb: percentile(idle, 0.5),
    baseline_samples: idle.length,
  };
}
