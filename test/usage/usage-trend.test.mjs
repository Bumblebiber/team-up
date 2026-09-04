import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pushSample,
  burnRate,
  windowIsDraining,
  modelUsageGate,
} from "../../src/usage/usage-windows.mjs";
import { mergeUsageWindows } from "../../src/usage/usage-collect.mjs";
import { pick, resolveLimitWindows } from "../../src/roster/chain.mjs";

const NOW = Date.parse("2026-09-04T12:00:00Z");
const LIMITS = { handoff_at: 0.95, handoff_at_burst: 0.8, project_min: 30 };
const min = (n) => n * 60_000;

/** A codex 5h window climbing `perMin` per minute over `spanMin`, ending now. */
function climbing({ used, perMin, spanMin = 30, resetsAt = "2026-09-04T15:00:00Z" }) {
  const history = [];
  for (let back = spanMin; back >= 0; back -= 10) {
    history.push({ at: NOW - min(back), used: used - perMin * back });
  }
  return { windows: { "codex:5h": { used, resets_at: resetsAt, history } } };
}

test("pushSample keeps an ordered ring and starts over on a reset", () => {
  let h = pushSample(undefined, { used: 0.2, at: NOW - min(20) });
  h = pushSample(h, { used: 0.5, at: NOW - min(10) });
  assert.deepEqual(h.map((s) => s.used), [0.2, 0.5]);
  h = pushSample(h, { used: 0.01, at: NOW });
  assert.deepEqual(h.map((s) => s.used), [0.01], "a drop means the window reset");
});

test("burnRate ignores a span too short to trust and never goes negative", () => {
  const short = { history: [{ at: NOW - min(2), used: 0.2 }, { at: NOW, used: 0.4 }] };
  assert.equal(burnRate(short, NOW), null);
  const dropped = { history: [{ at: NOW - min(20), used: 0.9 }, { at: NOW, used: 0.1 }] };
  assert.equal(burnRate(dropped, NOW), 0);
});

test("windowIsDraining fires on a climb that reaches the burst threshold", () => {
  // 60% now, 1%/min → 90% in 30min, past the 80% burst handoff.
  const drain = windowIsDraining("codex:5h", climbing({ used: 0.6, perMin: 0.01 }), LIMITS, NOW);
  assert.ok(drain, "expected the window to read as draining");
  assert.equal(Math.round(drain.projected * 100), 90);
  assert.equal(drain.horizon_min, 30);
});

test("windowIsDraining stays quiet on a flat window and on non-burst windows", () => {
  assert.equal(windowIsDraining("codex:5h", climbing({ used: 0.6, perMin: 0 }), LIMITS, NOW), null);
  const weekly = { windows: { "codex:weekly": climbing({ used: 0.6, perMin: 0.01 }).windows["codex:5h"] } };
  assert.equal(windowIsDraining("codex:weekly", weekly, LIMITS, NOW), null);
});

test("windowIsDraining never projects past the reset", () => {
  // Same climb, but the window resets in 5 minutes: only 65% is actually burnt.
  const soon = climbing({ used: 0.6, perMin: 0.01, resetsAt: "2026-09-04T12:05:00Z" });
  assert.equal(windowIsDraining("codex:5h", soon, LIMITS, NOW), null);
});

test("windowIsDraining is off when project_min is 0", () => {
  const usage = climbing({ used: 0.6, perMin: 0.01 });
  assert.equal(windowIsDraining("codex:5h", usage, { ...LIMITS, project_min: 0 }, NOW), null);
});

test("modelUsageGate blocks a draining cli and names the burn rate", () => {
  const gate = modelUsageGate({
    usage: climbing({ used: 0.6, perMin: 0.01 }),
    limitWindows: ["codex:5h"],
    provider: "openai",
    cli: "codex",
    limits: LIMITS,
    now: NOW,
  });
  assert.equal(gate.blocked, true);
  assert.match(gate.reason, /codex:5h at 60% and burning 1\.0%\/min/);
  assert.match(gate.reason, /in use elsewhere/);
});

test("mergeUsageWindows carries the sample ring across collects", () => {
  const first = mergeUsageWindows(null, {
    "codex:5h": { used: 0.2, updated: new Date(NOW - min(20)).toISOString() },
  });
  const second = mergeUsageWindows(first, {
    "codex:5h": { used: 0.5, updated: new Date(NOW).toISOString() },
  });
  assert.deepEqual(second.windows["codex:5h"].history.map((s) => s.used), [0.2, 0.5]);
  assert.equal(burnRate(second.windows["codex:5h"], NOW), 0.3 / min(20));
});

test("pick skips a draining codex model through the real window resolution", () => {
  // No limit_windows on the model: the gate has to reach codex:5h through
  // resolveLimitWindows, which is where the wiring broke before.
  const roster = {
    clis: { codex: { cmd: ["codex", "{prompt}"] }, cursor: { cmd: ["cursor-agent", "{prompt}"] } },
    models: {
      "gpt-5.6-sol": { provider: "openai", cli: ["codex"] },
      "composer-2.5": { provider: "cursor", cli: ["cursor"] },
    },
    roles: { implementer: { chain: ["gpt-5.6-sol", "composer-2.5"] } },
    limits: LIMITS,
  };
  assert.ok(
    resolveLimitWindows(roster, "gpt-5.6-sol", roster.models["gpt-5.6-sol"]).includes("codex:5h"),
    "a codex model must be gated on its 5h window",
  );

  const usage = climbing({ used: 0.6, perMin: 0.01 });
  const r = pick({ roster, usage, role: "implementer", now: NOW });
  assert.equal(r.model, "composer-2.5", "should fall through to the idle cli");
  assert.match(r.skipped[0].reason, /codex:5h .* burning .*in use elsewhere/);

  const calm = pick({ roster, usage: climbing({ used: 0.6, perMin: 0 }), role: "implementer", now: NOW });
  assert.equal(calm.model, "gpt-5.6-sol", "a flat 60% must still be usable");
});
