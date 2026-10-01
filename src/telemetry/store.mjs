import fs from "node:fs";
import path from "node:path";

export const DEFAULT_RETENTION_DAYS = 7;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function dayFile(dir, at) {
  return path.join(dir, `${String(at).slice(0, 10)}.jsonl`);
}

/**
 * Append one sample and fsync it before returning. A sample still in the page
 * cache when the machine dies is exactly the one the restart report needs.
 */
export function appendSample(sample, { dir }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(dayFile(dir, sample.at), "a", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(sample)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Day files in date order. Anything else in the directory is not ours. */
export function listDayFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => DAY_FILE.test(name)).sort().map((name) => path.join(dir, name));
}

/** Delete day files whose whole day lies more than `retentionDays` back. */
export function pruneTelemetry({ dir, now = new Date(), retentionDays = DEFAULT_RETENTION_DAYS }) {
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const removed = [];
  for (const file of listDayFiles(dir)) {
    const day = Date.parse(`${DAY_FILE.exec(path.basename(file))[1]}T00:00:00Z`);
    if (day + DAY_MS <= cutoff) {
      fs.rmSync(file, { force: true });
      removed.push(file);
    }
  }
  return removed;
}

function parseLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const sample = JSON.parse(line);
      if (sample && typeof sample.at === "string") out.push(sample);
    } catch {
      // A line cut off by the crash itself, most likely. Skip it.
    }
  }
  return out;
}

/** Samples in time order, optionally limited to `[since, until]`. */
export function readSamples({ dir, since = null, until = null }) {
  const lo = since ? String(since).slice(0, 10) : null;
  const hi = until ? String(until).slice(0, 10) : null;
  const out = [];
  for (const file of listDayFiles(dir)) {
    const day = path.basename(file, ".jsonl");
    if ((lo && day < lo) || (hi && day > hi)) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const sample of parseLines(text)) {
      if (since && sample.at < since) continue;
      if (until && sample.at > until) continue;
      out.push(sample);
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
