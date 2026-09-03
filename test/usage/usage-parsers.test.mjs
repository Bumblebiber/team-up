import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeUsage, claudeParseComplete } from "../../src/collectors/parse-claude-usage.mjs";
import { parseCodexStatus } from "../../src/collectors/parse-codex-status.mjs";
import { parseCursorUsage } from "../../src/collectors/parse-cursor-usage.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/usage");

test("parseClaudeUsage reads session/week/fable/5h", () => {
  const text = fs.readFileSync(path.join(FIX, "claude-usage.txt"), "utf8");
  const w = parseClaudeUsage(text, { now: "2026-07-17T12:00:00Z" });
  assert.equal(w["claude:session"].used, 0.07);
  assert.equal(w["claude:week"].used, 0.4);
  assert.equal(w["claude:fable-week"].used, 0.57);
  assert.equal(w["claude:5h"].used, 0.12);
  assert.ok(claudeParseComplete(w));
});

test("parseCodexStatus derives used from percent left", () => {
  const text = fs.readFileSync(path.join(FIX, "codex-status.txt"), "utf8");
  const w = parseCodexStatus(text);
  assert.equal(w["codex:weekly"].used, 1);
  assert.match(w["codex:weekly"].resets_at_raw, /23 Jul/);
  assert.match(w["codex:weekly"].resets_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(w["codex:weekly"].reset_confidence, "provider");
});

test("parseCodexStatus parses multiple limit lines including 5h above weekly", () => {
  const text = fs.readFileSync(path.join(FIX, "codex-status-with-5h.txt"), "utf8");
  const w = parseCodexStatus(text, { now: "2026-07-28T12:00:00Z" });
  assert.ok(Math.abs(w["codex:5h"].used - 0.58) < 1e-9);
  assert.match(w["codex:5h"].resets_at_raw, /28 Jul/);
  assert.ok(Math.abs(w["codex:weekly"].used - 0.01) < 1e-9);
  assert.match(w["codex:weekly"].resets_at_raw, /4 Aug/);
});

test("parseCodexStatus hit-limit fallback still works", () => {
  const text = "You have hit your usage limit for this period. Please try again at 3pm on 5 Aug.";
  const w = parseCodexStatus(text);
  assert.equal(w["codex:weekly"].used, 1);
  assert.match(w["codex:weekly"].resets_at_raw, /5 Aug/);
});

test("parseCursorUsage reads included/auto/api", () => {
  const text = fs.readFileSync(path.join(FIX, "cursor-usage.txt"), "utf8");
  const w = parseCursorUsage(text);
  assert.equal(w["cursor:included"].used, 0.54);
  assert.equal(w["cursor:auto"].used, 0.52);
  assert.equal(w["cursor:api"].used, 0.69);
});

/**
 * The fixture above was stripped by hand before it was ever committed, so it
 * proved nothing about the text the collector is actually handed. Straight off
 * the PTY the child rows carry colour escapes where the row regex expects
 * leading whitespace, and for weeks only "Included" — the one unstyled row —
 * was collected. These read the untouched transcript.
 */
test("parseCursorUsage reads all three rows out of a raw PTY transcript", () => {
  const text = fs.readFileSync(path.join(FIX, "cursor-usage-raw-pty.txt"), "utf8");
  const w = parseCursorUsage(text);
  assert.equal(w["cursor:included"].used, 0.11);
  assert.equal(w["cursor:auto"].used, 0.12);
  assert.equal(w["cursor:api"].used, 0.01);
});

test("parseCursorUsage carries the plan reset date onto every row", () => {
  const text = fs.readFileSync(path.join(FIX, "cursor-usage-raw-pty.txt"), "utf8");
  const w = parseCursorUsage(text, { now: "2026-09-02T15:00:00.000Z" });
  for (const key of ["cursor:included", "cursor:auto", "cursor:api"]) {
    assert.equal(w[key].resets_at_raw, "Sep 27");
    // "Sep 27" alone used to leave resets_at null; Date.parse would have read
    // it as the year 2001.
    assert.match(w[key].resets_at, /^2026-09-2[67]T/);
    assert.equal(w[key].reset_confidence, "provider");
  }
});

test("parseCodexStatus reads the 5h window out of a raw PTY transcript", () => {
  const text = fs.readFileSync(path.join(FIX, "codex-status-raw-pty.txt"), "utf8");
  const w = parseCodexStatus(text, { now: "2026-09-02T15:00:00.000Z" });
  assert.equal(w["codex:5h"].used, 0.32);
  assert.equal(w["codex:weekly"].used, 0.5);
  // Bare wall clock, no date — it used to leave resets_at null.
  assert.equal(w["codex:5h"].resets_at_raw, "19:41");
  assert.equal(w["codex:5h"].resets_at, "2026-09-02T17:41:00.000Z");
  assert.equal(w["codex:weekly"].resets_at, "2026-09-07T06:03:00.000Z");
});
