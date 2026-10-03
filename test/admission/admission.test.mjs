import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ADMISSION,
  admissionConfig,
  admit,
  applyRestartCap,
  checkAdmission,
  currentCap,
  deriveLimits,
  footprintFor,
  memoryCeiling,
  memoryDelegation,
  recordRefusal,
  resetCap,
  swapRising,
} from "../../src/admission/admission.mjs";
import { appendSample } from "../../src/telemetry/store.mjs";

const GB = 1024 * 1024;

function sample({ avail = 8 * GB, total = 16 * GB, swapUsed = 0, psi = { some: 1, full: 0 }, workers = 0, at = "2026-10-01T10:00:00.000Z" } = {}) {
  return {
    at,
    mem: { MemTotal: total, MemAvailable: avail, SwapTotal: 4 * GB, SwapFree: 4 * GB - swapUsed },
    psi: psi ? { memory: { some: { avg10: psi.some, avg60: 0 }, full: { avg10: psi.full, avg60: 0 } } } : { memory: null },
    workers: Array.from({ length: workers }, (_, i) => ({ runId: `r${i}` })),
  };
}

const LIMITS = { max_workers: 4, reserve_kb: GB, psi_some_max: 10, psi_full_max: 2, p95_rss_kb: GB, reason: "test" };

test("admit: each rule refuses on its own, and passes when all hold", () => {
  const ok = admit({ sample: sample(), limits: LIMITS, running: { workers: 1 }, recent: [sample(), sample()] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.headroom, { workers: 3, mem_kb: 6 * GB });

  const cases = [
    [{ running: { workers: 4 } }, /4 workers running, limit 4/],
    [{ sample: sample({ avail: 1.5 * GB }) }, /MemAvailable 1536 MB - 1024 MB for the worker < reserve 1024 MB/],
    [{ sample: sample({ psi: { some: 12, full: 0 } }) }, /some avg10 12 >= 10/],
    [{ sample: sample({ psi: { some: 1, full: 3 } }) }, /full avg10 3 >= 2/],
    [{ recent: [sample({ swapUsed: 100 * 1024 }), sample({ swapUsed: 400 * 1024 })], sample: sample({ swapUsed: 900 * 1024 }) }, /swap use rising: 100 MB → 400 MB → 900 MB/],
  ];
  for (const [over, re] of cases) {
    const decision = admit({ sample: sample(), limits: LIMITS, running: { workers: 0 }, recent: [sample(), sample()], ...over });
    assert.equal(decision.ok, false, String(re));
    assert.match(decision.reason, re);
  }
});

test("admit: missing PSI and too few samples are noted, not refused", () => {
  const decision = admit({ sample: sample({ psi: null }), limits: { ...LIMITS, p95_rss_kb: null }, running: { workers: 0 } });
  assert.equal(decision.ok, true);
  assert.ok(decision.notes.some((n) => /PSI unavailable/.test(n)));
  assert.ok(decision.notes.some((n) => /swap trend not checked/.test(n)));
  assert.ok(decision.notes.some((n) => /worker size unknown/.test(n)));
});

test("swapRising needs growth at every step and more than noise", () => {
  const s = (kb) => sample({ swapUsed: kb });
  assert.equal(swapRising([s(0), s(1)]), null);
  assert.equal(swapRising([s(0), s(500), s(900)]), false);
  assert.equal(swapRising([s(0), s(2048), s(1024)]), false);
  assert.equal(swapRising([s(0), s(1024), s(4096)]), true);
});

const FOOTPRINT = {
  all: { samples: 50, p95_rss_kb: 1.5 * GB },
  by_cli: { codex: { samples: 30, p95_rss_kb: GB }, claude: { samples: 5, p95_rss_kb: 3 * GB } },
  baseline_used_kb: 3 * GB,
};

test("deriveLimits: telemetry per cli, fallbacks with reasons, config and the restart cap win", () => {
  const codex = deriveLimits({ footprint: FOOTPRINT, cli: "codex", memTotalKb: 16 * GB });
  // floor((16 GB * 0.7 - 3 GB) / 1 GB) = 8
  assert.equal(codex.max_workers, 8);
  assert.equal(codex.source, "telemetry");
  assert.equal(codex.footprint_source, "cli codex");
  // claude has too few samples of its own: all workers' p95 stands in.
  assert.equal(deriveLimits({ footprint: FOOTPRINT, cli: "claude", memTotalKb: 16 * GB }).footprint_source, "all workers");

  const thin = deriveLimits({ footprint: { all: { samples: 3, p95_rss_kb: GB }, by_cli: {} }, cli: "codex", memTotalKb: 16 * GB });
  assert.equal(thin.max_workers, 2);
  assert.equal(thin.source, "fallback");
  assert.match(thin.reason, /fewer than 20 worker samples/);

  const noIdle = deriveLimits({ footprint: { ...FOOTPRINT, baseline_used_kb: null }, cli: "codex", memTotalKb: 16 * GB });
  assert.match(noIdle.reason, /no idle baseline/);

  const configured = deriveLimits({ footprint: FOOTPRINT, cli: "codex", memTotalKb: 16 * GB, config: { ...DEFAULT_ADMISSION, max_workers: 5 } });
  assert.equal(configured.max_workers, 5);
  assert.equal(configured.source, "config");

  const capped = deriveLimits({ footprint: FOOTPRINT, cli: "codex", memTotalKb: 16 * GB, cap: { max_workers: 3, verdict: "team_up_suspected" } });
  assert.equal(capped.max_workers, 3);
  assert.match(capped.reason, /admission reset/);
  assert.equal(footprintFor(FOOTPRINT, "gemini").source, "all workers");
});

// With no admission block and no telemetry every dispatch ran on the fallback
// of 2 workers, and the refusal never said how to lift it. The reason reaches
// `admission check` and every ADMISSION_REFUSED line, so it names the way out.
test("a fallback limit names how to lift it, and so does the refusal it causes", () => {
  const thin = { all: { samples: 3, p95_rss_kb: GB }, by_cli: {} };
  for (const footprint of [thin, { ...FOOTPRINT, baseline_used_kb: null }]) {
    const limits = deriveLimits({ footprint, cli: "codex", memTotalKb: 16 * GB });
    assert.equal(limits.source, "fallback");
    assert.match(limits.reason, /fallback limit 2 — .*admission\.max_workers.*team-up telemetry install-timer/);
    const refused = admit({ sample: sample(), limits, running: { workers: 2 }, recent: [sample(), sample()] });
    assert.match(refused.reason, /^2 workers running, limit 2 \(.*fallback limit 2 — .*install-timer/);
  }
  assert.doesNotMatch(deriveLimits({ footprint: FOOTPRINT, cli: "codex", memTotalKb: 16 * GB }).reason, /install-timer/);
});

test("roster.example.json documents an admission block that loads, $comment and all", () => {
  const example = JSON.parse(fs.readFileSync(new URL("../../roster.example.json", import.meta.url), "utf8"));
  assert.ok(example.admission, "the example names the admission block");
  assert.ok(example.admission.$comment, "and says what it is for");
  assert.equal(admissionConfig({}, { roster: example }).max_workers, example.admission.max_workers);
  assert.equal(admissionConfig({}, { roster: { admission: { $comment: "why", max_workers: 4 } } }).max_workers, 4);
});

test("admissionConfig validates every key", () => {
  assert.deepEqual(admissionConfig({}, { roster: {} }), { ...DEFAULT_ADMISSION, memory_ceiling: { ...DEFAULT_ADMISSION.memory_ceiling } });
  const custom = admissionConfig({}, { roster: { admission: { reserve_mb: 2048, max_workers: 3, memory_ceiling: { enabled: true } } } });
  assert.equal(custom.reserve_mb, 2048);
  assert.equal(custom.max_workers, 3);
  assert.equal(custom.memory_ceiling.enabled, true);
  assert.equal(custom.memory_ceiling.max_factor, 2);
  for (const bad of [
    { admission: [] },
    { admission: { nope: 1 } },
    { admission: { max_workers: 1.5 } },
    { admission: { reserve_mb: -1 } },
    { admission: { memory_ceiling: { enabled: "yes" } } },
    { admission: { memory_ceiling: { high_factor: 3, max_factor: 2 } } },
  ]) {
    assert.throws(() => admissionConfig({}, { roster: bad }), /ADMISSION_CONFIG/, JSON.stringify(bad));
  }
});

test("the restart cap: once per restart, lifted by reset, kept alive by refusals, gone after 24 h", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-admission-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { TEAM_UP_HOME: home };
  const t0 = new Date("2026-10-01T10:00:00Z");
  assert.ok(applyRestartCap({ maxWorkers: 3, verdict: "team_up_suspected", restartId: "boot-a", env, now: t0 }));
  assert.equal(currentCap({ env, now: t0 }).max_workers, 3);
  // A second resume in the same boot neither resets the clock nor undoes a reset.
  assert.equal(resetCap({ env }), true);
  assert.equal(applyRestartCap({ maxWorkers: 3, verdict: "team_up_suspected", restartId: "boot-a", env, now: t0 }), null);
  assert.equal(currentCap({ env, now: t0 }), null);
  // A new restart sets it again.
  applyRestartCap({ maxWorkers: 2, verdict: "team_up_suspected", restartId: "boot-b", env, now: t0 });
  const later = new Date(t0.getTime() + 20 * 3600_000);
  recordRefusal({ env, now: later });
  assert.equal(currentCap({ env, now: new Date(t0.getTime() + 30 * 3600_000) }).max_workers, 2);
  assert.equal(currentCap({ env, now: new Date(later.getTime() + 24 * 3600_000) }), null);
});

test("checkAdmission takes the live sample and the recent ones from telemetry", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-admission-check-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { TEAM_UP_HOME: home };
  const dir = path.join(home, "telemetry");
  appendSample(sample({ swapUsed: 0, at: "2026-10-01T09:59:00.000Z" }), { dir });
  appendSample(sample({ swapUsed: 2048, at: "2026-10-01T09:59:30.000Z" }), { dir });
  const decision = await checkAdmission({
    cli: "codex",
    env,
    now: new Date("2026-10-01T10:00:00Z"),
    config: DEFAULT_ADMISSION,
    footprint: FOOTPRINT,
    takeSample: async () => sample({ swapUsed: 8192, workers: 1 }),
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /swap use rising/);
  assert.equal(decision.limits.max_workers, 8);
});

test("memoryCeiling scales the cli's p95 only when enabled", () => {
  const on = { ...DEFAULT_ADMISSION, memory_ceiling: { enabled: true, high_factor: 1.5, max_factor: 2 } };
  assert.equal(memoryCeiling({ footprint: FOOTPRINT, cli: "codex", config: DEFAULT_ADMISSION }), null);
  assert.deepEqual(memoryCeiling({ footprint: FOOTPRINT, cli: "codex", config: on }), { high_kb: 1.5 * GB, max_kb: 2 * GB, source: "cli codex" });
  assert.equal(memoryCeiling({ footprint: { all: { samples: 1, p95_rss_kb: GB }, by_cli: {} }, cli: "codex", config: on }), null);
});

test("memoryDelegation reads the user manager's controllers", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-cgroup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "user.slice", "user-1000.slice", "user@1000.service");
  assert.equal(memoryDelegation({ cgroupRoot: root, uid: 1000 }).delegated, null);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cgroup.controllers"), "cpu pids\n");
  assert.equal(memoryDelegation({ cgroupRoot: root, uid: 1000 }).delegated, false);
  fs.writeFileSync(path.join(dir, "cgroup.controllers"), "cpu memory pids\n");
  assert.equal(memoryDelegation({ cgroupRoot: root, uid: 1000 }).delegated, true);
});
