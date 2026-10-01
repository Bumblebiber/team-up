import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeRestart,
  decideVerdict,
  defaultJournal,
  formatRestartReport,
  listRestartReports,
  journalPersistence,
  parseKernelOom,
  parseLast,
} from "../../src/telemetry/restart.mjs";
import { appendSample } from "../../src/telemetry/store.mjs";
import { BOOT, fakeProc, rmrf } from "./fake-proc.mjs";

const PREV = "99999999-8888-7777-6666-555555555555";
const GB = 1024 * 1024;

/**
 * Twenty samples from the previous boot, 30 s apart, ending at 10:10. Memory
 * falls to `endAvailable` and team-up holds `teamUpKb` with two workers.
 */
function plantPreviousBoot(dir, { endAvailable = 0.5 * GB, teamUpKb = 12 * GB, psiFull = 30, workers = 2 } = {}) {
  for (let i = 0; i < 20; i++) {
    const at = new Date(Date.parse("2026-10-01T10:00:30Z") + i * 30_000).toISOString();
    const available = i === 19 ? endAvailable : 8 * GB;
    const rows = Array.from({ length: workers }, (_, k) => ({
      runId: `20261001T090000Z-w${k}`, role: "code", cli: "claude",
      pids: [1000 + k, 2000 + k], comms: ["claude"], rss_kb: Math.round(teamUpKb / workers),
    }));
    appendSample({
      at, boot_id: PREV,
      mem: { MemTotal: 16 * GB, MemAvailable: available, SwapTotal: 0, SwapFree: 0 },
      psi: { memory: { some: { avg10: 50 }, full: { avg10: i === 19 ? psiFull : 0 } } },
      workers: rows,
      team_up_rss_kb: teamUpKb,
    }, { dir });
  }
}

function journal({ tail = { ok: true, entries: [{ at: "2026-10-01T10:10:05Z", message: "kernel: something" }], limited: false },
  kernel = { ok: true, entries: [], limited: false }, oomd = { ok: true, entries: [], limited: false }, last } = {}) {
  return {
    bootTail: () => tail,
    kernelOom: () => kernel,
    oomd: () => oomd,
    last: last ? () => last : undefined,
  };
}

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-restart-"));
  const proc = fakeProc({ bootId: BOOT });
  t.after(() => rmrf(home, proc));
  return {
    telemetryDir: path.join(home, "telemetry"),
    logDir: path.join(home, "logs"),
    procRoot: proc,
    persistence: () => ({ persistent: true, storage: "persistent", reason: "Storage=persistent" }),
  };
}

test("no telemetry from an earlier boot: nothing to judge", (t) => {
  const ctx = setup(t);
  assert.equal(analyzeRestart({ ...ctx, journal: journal() }), null);
  appendSample({ at: "2026-10-01T11:00:00Z", boot_id: BOOT, workers: [] }, { dir: ctx.telemetryDir });
  assert.equal(analyzeRestart({ ...ctx, journal: journal() }), null);
});

test("an orderly shutdown is a clean_shutdown whatever the memory did", (t) => {
  const ctx = setup(t);
  plantPreviousBoot(ctx.telemetryDir);
  const report = analyzeRestart({ ...ctx, journal: journal({
    tail: { ok: true, entries: [{ at: "2026-10-01T10:11:00Z", message: "Reached target System Power Off." }], limited: false },
  }) });
  assert.equal(report.verdict, "clean_shutdown");
  assert.equal(report.previous_boot_id, PREV);
  assert.deepEqual(report.shutdown, { kind: "clean", source: "journal", last_entry_at: "2026-10-01T10:11:00Z" });
});

test("an OOM kill of a team-up worker makes team-up the suspect", (t) => {
  const ctx = setup(t);
  plantPreviousBoot(ctx.telemetryDir, { endAvailable: 6 * GB, teamUpKb: 2 * GB, psiFull: 0 });
  const report = analyzeRestart({ ...ctx, journal: journal({
    kernel: { ok: true, limited: false, entries: [
      { at: "2026-10-01T10:09:58Z", message: "oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/user.slice/user-1000.slice/session-2.scope,task=claude,pid=1001,uid=1000" },
      { at: "2026-10-01T10:09:58Z", message: "Out of memory: Killed process 1001 (claude) total-vm:900000kB, anon-rss:800000kB" },
    ] },
  }) });
  assert.equal(report.verdict, "team_up_suspected");
  assert.equal(report.oom[0].team_up_run, "20261001T090000Z-w1");
  assert.equal(report.oom[0].contained, false);
  assert.ok(report.reasons.some((r) => /belonged to team-up/.test(r)));
  assert.ok(fs.existsSync(report.path));
});

test("an OOM kill of something else, with team-up small, is other_cause", (t) => {
  const ctx = setup(t);
  plantPreviousBoot(ctx.telemetryDir, { endAvailable: 0.4 * GB, teamUpKb: 1 * GB });
  const report = analyzeRestart({ ...ctx, journal: journal({
    kernel: { ok: true, limited: false, entries: [
      { at: "2026-10-01T10:09:58Z", message: "Out of memory: Killed process 4242 (postgres) total-vm:1kB" },
    ] },
  }) });
  assert.equal(report.verdict, "other_cause");
  assert.equal(report.oom[0].team_up_run, null);
  assert.equal(report.window.team_up_share_at_tightest, 0.06);
});

test("memory exhaustion without an OOM record still convicts on share", (t) => {
  const ctx = setup(t);
  plantPreviousBoot(ctx.telemetryDir, { endAvailable: 0.3 * GB, teamUpKb: 12 * GB });
  const report = analyzeRestart({ ...ctx, journal: journal() });
  assert.equal(report.verdict, "team_up_suspected");
  assert.equal(report.shutdown.kind, "unclean");
  assert.equal(report.window.samples, 20);
  assert.equal(report.window.min_mem_available_ratio, 0.019);
  assert.equal(report.window.max_psi_memory_full_avg10, 30);
  assert.equal(report.window.workers_last, 2);
  assert.equal(report.window.workers_max, 2);
  // Journal ended 10:10:05, five seconds after the last sample: no stall.
  assert.equal(report.window.sampler_gap_s, 5);
});

test("a kill inside a memory ceiling is the ceiling working, not exhaustion", (t) => {
  const ctx = setup(t);
  plantPreviousBoot(ctx.telemetryDir, { endAvailable: 8 * GB, teamUpKb: 12 * GB, psiFull: 0 });
  const report = analyzeRestart({ ...ctx, journal: journal({
    kernel: { ok: true, limited: false, entries: [
      { message: "oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=/x,task_memcg=/user.slice/team-up-20261001T090000Z-w0-abc.service,task=claude,pid=7,uid=1000", at: null },
    ] },
  }) });
  assert.equal(report.oom[0].contained, true);
  assert.equal(report.oom[0].team_up_run, "20261001T090000Z-w0");
  assert.equal(report.verdict, "unknown");
});

test("an unreadable journal leaves unknown and names the gaps", (t) => {
  const ctx = setup(t);
  plantPreviousBoot(ctx.telemetryDir, { endAvailable: 8 * GB, psiFull: 0 });
  const report = analyzeRestart({ ...ctx, journal: journal({
    tail: { ok: false, error: "Data from the specified boot is not available" },
    kernel: { ok: true, entries: [], limited: true },
    last: { ok: false, error: "no wtmp" },
  }) });
  assert.equal(report.verdict, "unknown");
  assert.equal(report.shutdown.kind, "unknown");
  assert.ok(report.evidence_gaps.some((g) => /previous boot not in the journal/.test(g)));
  assert.ok(report.evidence_gaps.some((g) => /kernel log not readable/.test(g)));
  assert.ok(report.evidence_gaps.some((g) => /wtmp not readable/.test(g)));
});

test("wtmp answers when the journal cannot", (t) => {
  const ctx = setup(t);
  plantPreviousBoot(ctx.telemetryDir);
  const report = analyzeRestart({ ...ctx, journal: journal({
    tail: { ok: false, error: "no boot" },
    last: { ok: true, text: "reboot   system boot  6.8.0 Wed Oct  1 10:15:00 2026   still running\nshutdown system down  6.8.0 Wed Oct  1 10:11:00 2026 - Wed Oct  1 10:15:00 2026  (00:04)\n" },
  }) });
  assert.equal(report.verdict, "clean_shutdown");
  assert.equal(report.shutdown.source, "wtmp");
});

test("a user-journal-only view says so", (t) => {
  const ctx = setup(t);
  plantPreviousBoot(ctx.telemetryDir);
  const report = analyzeRestart({ ...ctx, journal: journal({
    tail: { ok: true, limited: true, entries: [{ at: "2026-10-01T10:10:30Z", message: "Started team-up-telemetry.service" }] },
  }) });
  assert.equal(report.shutdown.kind, "unknown");
  assert.ok(report.evidence_gaps.some((g) => /system journal not readable/.test(g)));
  // Unknown shutdown with memory exhausted and team-up dominant still convicts.
  assert.equal(report.verdict, "team_up_suspected");
});

test("the report is written once per boot and returned from disk after", (t) => {
  const ctx = setup(t);
  plantPreviousBoot(ctx.telemetryDir);
  const first = analyzeRestart({ ...ctx, journal: journal() });
  assert.equal(first.cached, false);
  assert.equal(path.basename(first.path), `restart-${BOOT}.json`);
  const second = analyzeRestart({ ...ctx, journal: { bootTail: () => { throw new Error("must not ask again"); } } });
  assert.equal(second.cached, true);
  assert.equal(second.verdict, first.verdict);
  const listed = listRestartReports({ logDir: ctx.logDir, now: new Date(first.created_at) });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].verdict, first.verdict);
});

test("a dry run does not write", (t) => {
  const ctx = setup(t);
  plantPreviousBoot(ctx.telemetryDir);
  const report = analyzeRestart({ ...ctx, journal: journal(), write: false });
  assert.equal(report.path, null);
  assert.equal(fs.existsSync(ctx.logDir), false);
});

test("thresholds from config override the defaults and are recorded", (t) => {
  const ctx = setup(t);
  plantPreviousBoot(ctx.telemetryDir, { endAvailable: 0.3 * GB, teamUpKb: 12 * GB });
  const report = analyzeRestart({ ...ctx, journal: journal(), thresholds: { team_up_share: 0.99 } });
  assert.equal(report.verdict, "other_cause");
  assert.deepEqual(report.thresholds, { mem_available_ratio: 0.05, psi_full_avg10: 20, team_up_share: 0.99 });
  assert.ok(formatRestartReport(report)[0].startsWith("restart: other_cause"));
});

test("decideVerdict without any signal is unknown", () => {
  const v = decideVerdict({ shutdown: { kind: "unclean", source: "journal" }, oom: [], window: null });
  assert.equal(v.verdict, "unknown");
});

test("parseLast reads the boot before the current one", () => {
  assert.equal(parseLast("reboot system boot x still running\nshutdown system down x\n"), "clean");
  assert.equal(parseLast("reboot system boot x still running\nreboot system boot y - crash\n"), "unclean");
  assert.equal(parseLast("\nwtmp begins Mon"), null);
});

test("parseKernelOom merges the oom-kill and Killed process lines per pid", () => {
  const rows = parseKernelOom([
    { at: "t1", message: "oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/a,task=node,pid=5,uid=1" },
    { at: "t1", message: "Out of memory: Killed process 5 (node) total-vm:1kB" },
    { at: "t2", message: "Out of memory: Kill process 6 (old) score 900 or sacrifice child" },
  ]);
  assert.deepEqual(rows.map((r) => [r.pid, r.process, r.constraint, r.cgroup]), [
    [5, "node", "CONSTRAINT_NONE", "/a"],
    [6, "old", null, null],
  ]);
});

test("defaultJournal falls back to filtering when journalctl has no --grep", () => {
  const calls = [];
  const j = defaultJournal({
    run: (args) => {
      calls.push(args);
      if (args.includes("--grep")) return { ok: false, error: "Compiled without pattern matching support" };
      return { ok: true, limited: false, entries: [
        { at: "t", message: "usb 1-1: new device" },
        { at: "t", message: "Out of memory: Killed process 9 (x)" },
      ] };
    },
  });
  const r = j.kernelOom(PREV);
  assert.equal(r.entries.length, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes(PREV.replaceAll("-", "")));
});

test("a volatile journal is named, and its empty kernel log does not clear OOM", (t) => {
  const ctx = setup(t);
  plantPreviousBoot(ctx.telemetryDir, { endAvailable: 8 * GB, psiFull: 0 });
  const report = analyzeRestart({
    ...ctx,
    persistence: () => ({ persistent: false, storage: "auto", reason: "Storage=auto and /var/log/journal is missing" }),
    journal: journal({ tail: { ok: true, entries: [], limited: false }, last: { ok: false, error: "no wtmp" } }),
  });
  assert.equal(report.verdict, "unknown");
  assert.ok(report.evidence_gaps.some((g) => /journal is not persistent \(Storage=auto and/.test(g)));
  assert.ok(report.evidence_gaps.some((g) => /sudo mkdir -p \/var\/log\/journal/.test(g)));
  assert.ok(report.evidence_gaps.some((g) => /OOM kills cannot be ruled out/.test(g)));
});

test("journalPersistence reads Storage= with drop-ins winning, and auto falls back to the directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-journald-"));
  t.after(() => rmrf(root));
  const etcDir = path.join(root, "etc");
  const logDir = path.join(root, "journal");
  fs.mkdirSync(path.join(etcDir, "journald.conf.d"), { recursive: true });
  fs.writeFileSync(path.join(etcDir, "journald.conf"), "[Journal]\n#Storage=auto\n");
  assert.equal(journalPersistence({ etcDir, logDir }).persistent, false);
  fs.mkdirSync(logDir);
  assert.equal(journalPersistence({ etcDir, logDir }).persistent, true);
  fs.writeFileSync(path.join(etcDir, "journald.conf.d", "10-volatile.conf"), "[Journal]\nStorage=volatile\n");
  assert.deepEqual(journalPersistence({ etcDir, logDir }), { persistent: false, storage: "volatile", reason: "Storage=volatile" });
  assert.equal(journalPersistence({ etcDir: path.join(root, "none"), logDir }).persistent, null);
});
