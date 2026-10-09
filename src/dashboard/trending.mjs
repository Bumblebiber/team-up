// The AI Trending panel: the newest report of the GitHub trending scraper
// (a hermes cron job, ~/.hermes/scripts/github-trending-scraper.py). The
// scraper owns the data and writes markdown only; this reads the newest
// `trending-YYYY-MM-DD.md` and turns its tables back into rows.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE_RE = /^trending-(\d{4}-\d{2}-\d{2})\.md$/;

export const trendingDir = (env = process.env) =>
  env.TEAM_UP_TRENDING_DIR || path.join(os.homedir(), ".hermes", "cron-outputs", "framework-scout");

/** `| a | b \| c |` → ["a", "b | c"]. An escaped pipe stays in its cell. */
const cells = (line) =>
  line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

/**
 * Every `## ` heading becomes a section, every table row under it a repo.
 * Columns are positional (Repo, ⭐, Created, Lang, Description): the scraper
 * does not escape `|` in descriptions, so whatever spills past the fifth cell
 * is joined back into the description. A row without a `[name](url)` link
 * keeps its text as the name and gets no url.
 */
export function parseTrending(markdown) {
  const sections = [];
  for (const line of String(markdown).split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      sections.push({ title: line.slice(3).trim(), repos: [] });
      continue;
    }
    const section = sections.at(-1);
    if (!section || !line.trim().startsWith("|")) continue;
    const [repo = "", stars = "", created = "", lang = "", ...desc] = cells(line);
    if (!repo || /^:?-+:?$/.test(repo) || repo.toLowerCase() === "repo") continue;
    const link = repo.match(/^\[([^\]]*)\]\((\S*)\)$/);
    const url = link?.[2] || "";
    const starCount = Number(stars.replace(/[,\s]/g, ""));
    section.repos.push({
      name: link ? link[1] : repo,
      // Only http(s): the page renders this as an href.
      url: /^https?:\/\//i.test(url) ? url : null,
      stars: stars && Number.isFinite(starCount) ? starCount : null,
      created,
      lang,
      description: desc.join(" | "),
    });
  }
  return { sections };
}

// ponytail: one cached file per process, keyed by path + mtime; the newest
// report is the only one ever shown.
let cache = null;

/** Newest report as `{date, sections}`, or null when there is none. */
export function readTrending({ env = process.env } = {}) {
  const dir = trendingDir(env);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const name = names.filter((n) => FILE_RE.test(n)).sort().at(-1);
  if (!name) return null;
  const file = path.join(dir, name);
  const { mtimeMs } = fs.statSync(file);
  if (cache?.file !== file || cache.mtimeMs !== mtimeMs) {
    cache = { file, mtimeMs, data: { date: name.match(FILE_RE)[1], ...parseTrending(fs.readFileSync(file, "utf8")) } };
  }
  return cache.data;
}
