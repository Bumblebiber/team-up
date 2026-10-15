import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectWorkerLimitBanner,
  limitTtlMs,
  BANNER_TAIL_LINES,
  paneBannerTail,
} from "../../src/runs/worker-limit-banner.mjs";
import { pick } from "../../src/roster/chain.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/panes");

function readFixture(rel) {
  return fs.readFileSync(path.join(FIXTURES, rel), "utf8");
}

const NOW = Date.parse("2026-10-03T13:29:18Z");

test("claude weekly limit banner at pane tail", () => {
  const pane = readFixture("claude/limit-banner-2.1.220-weekly.txt");
  const m = detectWorkerLimitBanner(pane, "claude", NOW);
  assert.equal(m?.windowKey, "claude:week");
  assert.match(m?.resetRaw || "", /Oct 5, 10am/i);
  assert.ok(m.ttlMs > 0 && m.ttlMs < 7 * 86_400_000);
});

test("claude 5-hour limit banner at pane tail", () => {
  const pane = readFixture("claude/limit-banner-2.1.220-5h.txt");
  const m = detectWorkerLimitBanner(pane, "claude", NOW);
  assert.equal(m?.windowKey, "claude:5h");
  assert.match(m?.resetRaw || "", /2:30am/i);
});

test("claude unparsable reset falls back to 5h ttl", () => {
  const pane = readFixture("claude/limit-banner-2.1.220-unparsable.txt");
  const m = detectWorkerLimitBanner(pane, "claude", NOW);
  assert.ok(m);
  assert.equal(m.ttlMs, 5 * 3_600_000);
  assert.equal(m.resetRaw, null);
});

test("codex weekly limit banner at pane tail", () => {
  const berlinNow = Date.parse("2026-09-25T17:40:26Z");
  const pane = readFixture("codex/limit-banner-0.157.0-weekly.txt");
  const m = detectWorkerLimitBanner(pane, "codex", berlinNow);
  assert.equal(m?.windowKey, "codex:weekly");
  assert.equal(m?.resetRaw, "8:51 PM");
});

test("codex 5h limit banner at pane tail", () => {
  const now = Date.parse("2026-08-01T12:00:00Z");
  const pane = readFixture("codex/limit-banner-0.157.0-5h.txt");
  const m = detectWorkerLimitBanner(pane, "codex", now);
  assert.equal(m?.windowKey, "codex:5h");
  assert.equal(m?.resetRaw, "3pm on 5 Aug");
});

test("codex unparsable reset falls back to 5h ttl", () => {
  const pane = readFixture("codex/limit-banner-0.157.0-unparsable.txt");
  const m = detectWorkerLimitBanner(pane, "codex", NOW);
  assert.ok(m);
  assert.equal(m.ttlMs, 5 * 3_600_000);
});

test("limit strings in scrollback above the tail do not trigger", () => {
  const pane = readFixture("claude/limit-banner-2.1.220-source-false-positive.txt");
  assert.equal(detectWorkerLimitBanner(pane, "claude", NOW), null);
  assert.equal(detectWorkerLimitBanner(pane, "codex", NOW), null);
});

test("paneBannerTail only keeps the last lines", () => {
  const lines = Array.from({ length: BANNER_TAIL_LINES + 5 }, (_, i) => `line-${i}`);
  const pane = lines.join("\n");
  const tail = paneBannerTail(pane);
  assert.ok(!tail.includes("line-0"));
  assert.ok(tail.includes(`line-${lines.length - 1}`));
});

test("limitTtlMs uses parsed reset when available", () => {
  const ttl = limitTtlMs("Oct 5, 10am (Europe/Berlin)", NOW);
  assert.equal(ttl, Date.parse("2026-10-05T08:00:00Z") - NOW);
});
