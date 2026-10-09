import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTrending, readTrending } from "../../src/dashboard/trending.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "trending", "trending-2026-07-16.md");

test("parseTrending reads a real scraper report", () => {
  const { sections } = parseTrending(fs.readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(sections.map((s) => [s.title, s.repos.length]), [
    ["🆕 New & Trending — Last 7 Days", 15],
    ["📅 New & Trending — Last 30 Days", 15],
    ["📈 Fastest Growing — Recent Activity (24h)", 0],
  ]);
  assert.deepEqual(sections[0].repos[0], {
    name: "Flawless",
    url: "https://github.com/William-Lu-stack/Flawless",
    stars: 678,
    created: "2026-07-10",
    lang: "Python",
    description: "AI SRE AgenticOps for Kubernetes and cloud infrastructure.",
  });
  assert.equal(sections[1].repos[0].stars, 2690);
  // The scraper does not escape `|` in descriptions; the spill is joined back.
  const edgeever = sections[1].repos.find((r) => r.name === "edgeever");
  assert.equal(edgeever.lang, "TypeScript");
  assert.equal(edgeever.description,
    "Serverless, 100% free, and open-source Evernote alternative on Cloudflare with native MCP | 无需服务器、0费用、原生支持 AI Agent 的开源自");
  const tickflow = sections[1].repos.find((r) => r.name === "tickflow-stock-panel");
  assert.equal(tickflow.description.split(" | ").length, 5);
});

test("parseTrending tolerates missing columns and odd rows", () => {
  const md = [
    "| [stray](https://github.com/a/stray) | 1 | | | before any heading |",
    "## Odd",
    "",
    "| Repo | ⭐ |",
    "|---|---|",
    "| plain-name | lots |",
    "| [short](https://github.com/a/short) | 12 |",
    "| [evil](javascript:alert(1)) | 3 | 2026-01-01 | JS | say \"hi\" \\| bye |",
    "not a table line",
    "## Empty",
    "| Repo | ⭐ | Created | Lang | Description |",
    "|------|-----|---------|------|-------------|",
  ].join("\n");
  const { sections } = parseTrending(md);
  assert.deepEqual(sections.map((s) => s.title), ["Odd", "Empty"]);
  assert.deepEqual(sections[1].repos, []);
  assert.deepEqual(sections[0].repos, [
    { name: "plain-name", url: null, stars: null, created: "", lang: "", description: "" },
    { name: "short", url: "https://github.com/a/short", stars: 12, created: "", lang: "", description: "" },
    { name: "evil", url: null, stars: 3, created: "2026-01-01", lang: "JS", description: 'say "hi" | bye' },
  ]);
  assert.deepEqual(parseTrending("").sections, []);
});

test("readTrending picks the newest dated report and re-reads it only when it changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-trending-"));
  const env = { TEAM_UP_TRENDING_DIR: dir };
  try {
    assert.equal(readTrending({ env }), null, "empty dir");
    assert.equal(readTrending({ env: { TEAM_UP_TRENDING_DIR: path.join(dir, "missing") } }), null);

    const report = (name) => `## ${name}\n| [${name}](https://github.com/a/${name}) | 1 | | | |\n`;
    fs.writeFileSync(path.join(dir, "trending-2026-01-01.md"), report("old"));
    fs.writeFileSync(path.join(dir, "trending-2026-01-02.md"), report("new"));
    fs.writeFileSync(path.join(dir, "trending-cron.log"), "log");
    fs.writeFileSync(path.join(dir, "report-2026-01-03.md"), report("report"));

    const first = readTrending({ env });
    assert.equal(first.date, "2026-01-02");
    assert.equal(first.sections[0].repos[0].name, "new");
    assert.equal(readTrending({ env }), first, "same mtime: cached");

    const file = path.join(dir, "trending-2026-01-02.md");
    fs.writeFileSync(file, report("rewritten"));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(readTrending({ env }).sections[0].repos[0].name, "rewritten");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
