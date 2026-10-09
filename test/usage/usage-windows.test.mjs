import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseResetAt,
  windowIsBlocking,
  modelUsageGate,
  isCliUsageFresh,
  isWindowUsageFresh,
  effectiveResetAt,
  resolveHandoffAt,
  WINDOW_MAX_AGE_MS,
} from "../../src/usage/usage-windows.mjs";

const NOW = Date.parse("2026-07-17T12:00:00Z");

test("parseResetAt parses ISO reset strings", () => {
  assert.equal(parseResetAt("2026-07-23T17:26:00Z", NOW), Date.parse("2026-07-23T17:26:00Z"));
});

test("parseResetAt converts codex local wall time to UTC (CEST)", () => {
  const berlin = "Europe/Berlin";
  const summerNow = Date.parse("2026-07-28T12:00:00Z");
  const codex = parseResetAt("14:28 on 4 Aug", summerNow, { timeZone: berlin });
  assert.equal(codex, Date.parse("2026-08-04T12:28:00.000Z"));
});

test("parseResetAt converts codex local wall time to UTC (CET winter)", () => {
  const berlin = "Europe/Berlin";
  const winterNow = Date.parse("2025-12-15T12:00:00Z");
  const codex = parseResetAt("14:28 on 4 Jan", winterNow, { timeZone: berlin });
  assert.equal(codex, Date.parse("2026-01-04T13:28:00.000Z"));
});

test("parseResetAt rolls codex date to next year when month/day already passed", () => {
  const berlin = "Europe/Berlin";
  const winter = Date.parse("2026-12-15T12:00:00Z");
  const codex = parseResetAt("17:26 on 23 Jul", winter, { timeZone: berlin });
  assert.equal(codex, Date.parse("2027-07-23T15:26:00.000Z"));
});

test("windowIsBlocking ignores windows past resets_at", () => {
  const usage = {
    windows: {
      "codex:weekly": { used: 1.0, resets_at: "2026-07-16T10:00:00Z" },
    },
  };
  assert.equal(windowIsBlocking("codex:weekly", usage, 0.95, NOW), false);
});

test("agy weekly and 5h quota windows use matching stale-reading ceilings", () => {
  assert.equal(WINDOW_MAX_AGE_MS["agy:gemini-weekly"], 7 * 86_400_000);
  assert.equal(WINDOW_MAX_AGE_MS["agy:gemini-5h"], 5 * 3_600_000);
  assert.equal(WINDOW_MAX_AGE_MS["agy:3p-weekly"], 7 * 86_400_000);
  assert.equal(WINDOW_MAX_AGE_MS["agy:3p-5h"], 5 * 3_600_000);
});

test("agy explicit quota windows never fall back to Claude provider usage", () => {
  const gate = modelUsageGate({
    usage: {
      windows: { "claude:week": { used: 0.99 } },
      providers: { anthropic: { used: 0.99 } },
    },
    limitWindows: ["agy:3p-weekly", "agy:3p-5h"],
    provider: "anthropic",
    cli: "agy",
    limits: 0.95,
    now: NOW,
  });
  assert.deepEqual(gate, { blocked: false });
});

test("windowIsBlocking expires hot windows without resets_at after max age from updated", () => {
  const updated = new Date(NOW - WINDOW_MAX_AGE_MS["codex:weekly"] - 60_000).toISOString();
  const usage = {
    windows: {
      "codex:weekly": { used: 1.0, updated },
    },
  };
  assert.equal(windowIsBlocking("codex:weekly", usage, 0.95, NOW), false);
});

test("windowIsBlocking keeps sub-threshold windows without resets_at", () => {
  const usage = {
    windows: {
      "codex:weekly": { used: 0.5, updated: "2020-01-01T00:00:00Z" },
    },
  };
  assert.equal(windowIsBlocking("codex:weekly", usage, 0.95, NOW), false);
});

test("effectiveResetAt uses updated+maxAge only for hot windows", () => {
  const hot = { used: 1.0, updated: "2026-07-17T10:00:00Z" };
  const cool = { used: 0.5, updated: "2026-07-17T10:00:00Z" };
  assert.ok(effectiveResetAt(hot, "codex:weekly", 0.95, NOW) > NOW);
  assert.equal(effectiveResetAt(cool, "codex:weekly", 0.95, NOW), null);
});

test("modelUsageGate falls back to provider when model has no window data", () => {
  const usage = {
    windows: { "claude:5h": { used: 0.1 } },
    providers: { openai: { used: 0.99 } },
  };
  const gate = modelUsageGate({
    usage,
    limitWindows: ["codex:weekly"],
    provider: "openai",
    cli: "codex",
    handoffAt: 0.95,
    now: NOW,
  });
  assert.equal(gate.blocked, true);
  assert.match(gate.reason, /provider openai/);
});

test("modelUsageGate blocks only this model's windows when present", () => {
  const usage = {
    windows: {
      "claude:fable-week": { used: 0.99 },
      "claude:5h": { used: 0.1 },
    },
  };
  const hot = modelUsageGate({
    usage,
    limitWindows: ["claude:fable-week", "claude:5h"],
    provider: "anthropic",
    cli: "claude",
    handoffAt: 0.95,
    now: NOW,
  });
  const cool = modelUsageGate({
    usage,
    limitWindows: ["claude:5h"],
    provider: "anthropic",
    cli: "claude",
    handoffAt: 0.95,
    now: NOW,
  });
  assert.equal(hot.blocked, true);
  assert.equal(cool.blocked, false);
});

test("codex:5h uses burst handoff threshold via isBurstWindow pattern", () => {
  const limits = { handoff_at: 0.95, handoff_at_burst: 0.8 };
  assert.equal(resolveHandoffAt("codex:5h", limits), 0.8);
  assert.equal(WINDOW_MAX_AGE_MS["codex:5h"], 5 * 3_600_000);
});

test("resolveHandoffAt uses handoff_at_burst for 5h/session windows, handoff_at otherwise", () => {
  const limits = { handoff_at: 0.95, handoff_at_burst: 0.8 };
  assert.equal(resolveHandoffAt("claude:5h", limits), 0.8);
  assert.equal(resolveHandoffAt("claude:session", limits), 0.8);
  assert.equal(resolveHandoffAt("claude:week", limits), 0.95);
  assert.equal(resolveHandoffAt("codex:weekly", limits), 0.95);
  // bare number stays a flat threshold for legacy callers
  assert.equal(resolveHandoffAt("claude:5h", 0.9), 0.9);
  // missing handoff_at_burst falls back to its own 0.8 default
  assert.equal(resolveHandoffAt("claude:5h", { handoff_at: 0.95 }), 0.8);
});

test("windowIsBlocking honors the burst threshold for claude:5h", () => {
  const limits = { handoff_at: 0.95, handoff_at_burst: 0.8 };
  const usage = { windows: { "claude:5h": { used: 0.81 } } };
  assert.equal(windowIsBlocking("claude:5h", usage, limits, NOW), true);
  assert.equal(windowIsBlocking("claude:week", { windows: { "claude:week": { used: 0.81 } } }, limits, NOW), false);
});

test("isCliUsageFresh respects per-cli window updated timestamps", () => {
  const usage = {
    windows: {
      "claude:5h": { used: 0.1, updated: "2026-07-17T11:58:00Z" },
      "codex:weekly": { used: 0.5, updated: "2026-07-17T10:00:00Z" },
    },
  };
  assert.equal(isCliUsageFresh("claude", usage, 5 * 60_000, NOW), true);
  assert.equal(isCliUsageFresh("codex", usage, 5 * 60_000, NOW), false);
});

test("isWindowUsageFresh checks only the window reading", () => {
  assert.equal(
    isWindowUsageFresh({ updated_at: "2026-07-17T11:58:00Z" }, 5 * 60_000, NOW),
    true,
  );
  assert.equal(
    isWindowUsageFresh({ updated_at: "2026-07-17T10:00:00Z" }, 5 * 60_000, NOW),
    false,
  );
});

/**
 * Two collectors print a reset that is missing half of a date: cursor gives a
 * month and day with no time, codex's 5h window gives a time with no day.
 * Both fell through to `Date.parse`, which does not reject a partial date — it
 * invents the missing part. "Sep 27" came back as 2001, so the reset landed
 * permanently in the past and `resets_at` was written as null.
 */
test("parseResetAt reads a bare month and day as the next such date", () => {
  const berlin = "Europe/Berlin";
  const now = Date.parse("2026-09-02T15:00:00Z");
  assert.equal(
    parseResetAt("Sep 27", now, { timeZone: berlin }),
    Date.parse("2026-09-26T22:00:00Z") // midnight on the 27th, Berlin
  );
});

test("parseResetAt rolls a bare month and day into next year once it has passed", () => {
  const berlin = "Europe/Berlin";
  const now = Date.parse("2026-11-02T15:00:00Z");
  const ts = parseResetAt("Sep 27", now, { timeZone: berlin });
  assert.ok(ts > now, "a reset already past this year belongs to the next one");
  assert.equal(new Date(ts).getUTCFullYear(), 2027);
});

test("parseResetAt reads a bare wall clock as today when it is still ahead", () => {
  const berlin = "Europe/Berlin";
  const now = Date.parse("2026-09-02T15:00:00Z"); // 17:00 Berlin
  assert.equal(
    parseResetAt("19:41", now, { timeZone: berlin }),
    Date.parse("2026-09-02T17:41:00Z")
  );
});

test("parseResetAt rolls a bare wall clock to tomorrow once it has passed", () => {
  const berlin = "Europe/Berlin";
  const now = Date.parse("2026-09-02T15:00:00Z"); // 17:00 Berlin
  assert.equal(
    parseResetAt("08:00", now, { timeZone: berlin }),
    Date.parse("2026-09-03T06:00:00Z")
  );
});

test("parseResetAt refuses a date that is nowhere near now", () => {
  const now = Date.parse("2026-09-02T15:00:00Z");
  // The guard that keeps Date.parse from answering for partial dates must not
  // start accepting a genuinely absurd one either.
  assert.equal(parseResetAt("2001-09-27T00:00:00Z", now), null);
});

/**
 * The clock in a reset string comes in more shapes than H:MM. Claude prints an
 * hour alone on the hour ("10am"), and codex's hit-limit banner says "try
 * again at 8:51 PM" (run 20260925T170605Z-s8un). Each parsed to null, so the
 * live claude:week window carried resets_at: null and a blocked week fell back
 * to updated + 7 days.
 */
test("claude /usage fixture: an hour-only reset parses, not just the used share", async () => {
  const fs = await import("node:fs");
  const { parseClaudeUsage } = await import("../../src/collectors/parse-claude-usage.mjs");
  const text = fs.readFileSync(new URL("./fixtures/usage/claude-usage.txt", import.meta.url), "utf8");
  const w = parseClaudeUsage(text, { now: "2026-07-17T12:00:00Z" });
  // "Jul 20, 10am (Europe/Berlin)" — CEST is UTC+2.
  assert.equal(w["claude:week"].resets_at, "2026-07-20T08:00:00.000Z");
  assert.equal(w["claude:fable-week"].resets_at, "2026-07-20T08:00:00.000Z");
  assert.equal(w["claude:week"].reset_confidence, "provider");
  // The H:MM forms keep working.
  assert.equal(w["claude:session"].resets_at, "2026-07-17T18:10:00.000Z");
  assert.equal(w["claude:5h"].resets_at, "2026-07-17T19:00:00.000Z");
});

test("parseResetAt reads claude's hour-only reset with its zone suffix", () => {
  const now = Date.parse("2026-10-03T13:29:18Z");
  assert.equal(
    parseResetAt("Oct 5, 10am (Europe/Berlin)", now),
    Date.parse("2026-10-05T08:00:00Z")
  );
});

test("parseResetAt reads codex's hit-limit '<h>pm on <d> <Mon>' in local time", () => {
  const berlin = "Europe/Berlin";
  const now = Date.parse("2026-08-01T12:00:00Z");
  assert.equal(
    parseResetAt("3pm on 5 Aug", now, { timeZone: berlin }),
    Date.parse("2026-08-05T13:00:00Z")
  );
});

test("parseResetAt reads codex's hit-limit '8:51 PM' as a bare 12-hour clock", () => {
  const berlin = "Europe/Berlin";
  const now = Date.parse("2026-09-25T17:40:26Z"); // 19:40 Berlin, when s8un hit it
  assert.equal(
    parseResetAt("8:51 PM", now, { timeZone: berlin }),
    Date.parse("2026-09-25T18:51:00Z")
  );
});

test("parseCodexStatus hit-limit banner carries a parsed reset", async () => {
  const { parseCodexStatus } = await import("../../src/collectors/parse-codex-status.mjs");
  const w = parseCodexStatus(
    "You’ve hit your usage limit. Upgrade to Pro or try again at 8:51 PM.",
    { now: "2026-09-25T17:40:26Z" }
  );
  assert.equal(w["codex:weekly"].resets_at_raw, "8:51 PM");
  assert.match(w["codex:weekly"].resets_at, /^2026-09-2[56]T/);
});

test("parseResetAt does not read a bare number as a clock", () => {
  const now = Date.parse("2026-09-02T15:00:00Z");
  assert.equal(parseResetAt("10", now, { timeZone: "Europe/Berlin" }), null);
  assert.equal(parseResetAt("13pm", now, { timeZone: "Europe/Berlin" }), null);
});

/**
 * A raw reset names the next such moment after it was read, not after now.
 * Records written before the hour-only parse landed carry resets_at: null and
 * resets_at_raw "Oct 5, 10am (Europe/Berlin)"; read against now, the reset
 * rolled forward to 2027 the moment it passed and the window never unblocked.
 */
test("a raw reset is read against the reading's own time, so it expires once passed", () => {
  const legacy = {
    used: 1,
    resets_at: null,
    resets_at_raw: "Oct 5, 10am (Europe/Berlin)",
    updated_at: "2026-09-29T12:00:00Z",
  };
  const usage = { windows: { "claude:week": legacy } };
  const before = Date.parse("2026-10-05T07:00:00Z");
  const after = Date.parse("2026-10-05T09:00:00Z");
  assert.equal(effectiveResetAt(legacy, "claude:week", 0.95, after), Date.parse("2026-10-05T08:00:00Z"));
  assert.equal(windowIsBlocking("claude:week", usage, 0.95, before), true);
  assert.equal(windowIsBlocking("claude:week", usage, 0.95, after), false);
});

test("an unparseable raw reset still expires updated + max age", () => {
  const w = { used: 1, resets_at: null, resets_at_raw: "soon", updated_at: "2026-09-29T12:00:00Z" };
  const usage = { windows: { "claude:week": w } };
  const ceiling = Date.parse("2026-09-29T12:00:00Z") + WINDOW_MAX_AGE_MS["claude:week"];
  assert.equal(effectiveResetAt(w, "claude:week", 0.95, ceiling - 1), ceiling);
  assert.equal(windowIsBlocking("claude:week", usage, 0.95, ceiling - 1), true);
  assert.equal(windowIsBlocking("claude:week", usage, 0.95, ceiling), false);
});

test("a collector-written ISO reset blocks until it passes", () => {
  const w = {
    used: 1,
    resets_at: "2026-10-05T08:00:00.000Z",
    resets_at_raw: "Oct 5, 10am (Europe/Berlin)",
    updated_at: "2026-10-03T12:00:00Z",
  };
  const usage = { windows: { "claude:week": w } };
  assert.equal(windowIsBlocking("claude:week", usage, 0.95, Date.parse("2026-10-05T07:59:00Z")), true);
  assert.equal(windowIsBlocking("claude:week", usage, 0.95, Date.parse("2026-10-05T08:00:00Z")), false);
});
