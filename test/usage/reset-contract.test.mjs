import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeUsage } from "../../src/collectors/parse-claude-usage.mjs";
import { parseCursorUsage } from "../../src/collectors/parse-cursor-usage.mjs";

test("collector preserves raw reset and emits ISO reset", () => {
  const windows = parseClaudeUsage(
    "Current 5h: 96% used · resets Jul 25, 8:10pm (Europe/Berlin)",
    { now: "2026-07-25T16:00:00Z" }
  );
  assert.equal(windows["claude:5h"].resets_at_raw, "Jul 25, 8:10pm (Europe/Berlin)");
  assert.equal(windows["claude:5h"].resets_at, "2026-07-25T18:10:00.000Z");
  assert.equal(windows["claude:5h"].reset_confidence, "provider");
});

test("unknown cursor reset is explicit", () => {
  const windows = parseCursorUsage("Included 91% used");
  assert.equal(windows["cursor:included"].resets_at, null);
  assert.equal(windows["cursor:included"].reset_confidence, "unknown");
});
