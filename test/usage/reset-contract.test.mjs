import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWindowRecord } from "../../src/usage/usage-windows.mjs";
import { parseCursorUsage } from "../../src/collectors/parse-cursor-usage.mjs";

test("window records preserve raw reset and emit ISO reset", () => {
  const record = normalizeWindowRecord(
    "claude:5h",
    { used: 0.96, resets_at_raw: "Jul 25, 8:10pm (Europe/Berlin)", source: "claude:oauth-usage-api" },
    { now: "2026-07-25T16:00:00Z" },
  );
  assert.equal(record.resets_at_raw, "Jul 25, 8:10pm (Europe/Berlin)");
  assert.equal(record.resets_at, "2026-07-25T18:10:00.000Z");
  assert.equal(record.reset_confidence, "provider");
});

test("unknown cursor reset is explicit", () => {
  const windows = parseCursorUsage("Included 91% used");
  assert.equal(windows["cursor:included"].resets_at, null);
  assert.equal(windows["cursor:included"].reset_confidence, "unknown");
});
