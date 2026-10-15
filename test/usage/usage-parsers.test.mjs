import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCursorUsage } from "../../src/collectors/parse-cursor-usage.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/usage");

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
