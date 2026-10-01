import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  childLookup,
  parsePressure,
  parseStat,
  processTree,
  readBootId,
  readCgroup,
  readLoad,
  readMeminfo,
  readPressure,
  readUptime,
  sumProcesses,
} from "../../src/telemetry/proc.mjs";
import { BOOT, fakeCgroup, fakeProc, rmrf } from "./fake-proc.mjs";

test("machine-wide readings come from a planted /proc", () => {
  const root = fakeProc({ mem: { MemTotal: 100, MemAvailable: 40, SwapTotal: 10, SwapFree: 7 } });
  try {
    assert.equal(readBootId(root), BOOT);
    assert.equal(readUptime(root), 1234.56);
    assert.deepEqual(readLoad(root), [0.5, 0.4, 0.3]);
    assert.deepEqual(readMeminfo(root), { MemTotal: 100, MemAvailable: 40, SwapTotal: 10, SwapFree: 7 });
    const psi = readPressure(root);
    assert.deepEqual(psi.memory, { some: { avg10: 1.5, avg60: 0.8 }, full: { avg10: 0.5, avg60: 0.2 } });
    // An older kernel's cpu file has no `full` line.
    assert.deepEqual(psi.cpu, { some: { avg10: 3, avg60: 2 }, full: null });
  } finally {
    rmrf(root);
  }
});

test("missing files degrade to null instead of throwing", () => {
  const root = fakeProc({ pressure: false });
  try {
    fs.rmSync(path.join(root, "meminfo"));
    assert.deepEqual(readPressure(root), { memory: null, cpu: null, io: null });
    assert.equal(readMeminfo(root), null);
    assert.equal(parsePressure(""), null);
    assert.equal(readBootId(path.join(root, "nowhere")), null);
  } finally {
    rmrf(root);
  }
});

test("parseStat counts fields from the last parenthesis", () => {
  const stat = parseStat("42 (tmux: server (x)) S 7 0 0 0 0 0 0 0 0 0 150 50 0 0\n");
  assert.deepEqual(stat, { pid: 42, comm: "tmux: server (x)", ppid: 7, cpu_ticks: 200, start_ticks: null });
  const full = parseStat("42 (claude) S 7 0 0 0 0 0 0 0 0 0 150 50 0 0 20 0 1 0 98765 0 0\n");
  assert.equal(full.start_ticks, 98765);
  assert.equal(parseStat("garbage"), null);
});

const TREE = [
  { pid: 10, ppid: 1, comm: "bash", rss_kb: 1000, utime: 10, stime: 0 },
  { pid: 11, ppid: 10, comm: "claude", rss_kb: 300_000, utime: 400, stime: 100 },
  { pid: 12, ppid: 11, comm: "node", rss_kb: 50_000, utime: 0, stime: 0 },
  { pid: 13, ppid: 1, comm: "unrelated", rss_kb: 9_999_999 },
  { pid: 14, ppid: 10, comm: "kworker", rss_kb: null },
];

test("processTree walks task children files", () => {
  const root = fakeProc({
    processes: TREE.map((p) => ({ ...p, children: { 10: [11, 14], 11: [12] }[p.pid] ?? [] })),
  });
  try {
    const procs = processTree(10, { procRoot: root });
    assert.deepEqual(procs.map((p) => p.pid).sort(), [10, 11, 12, 14]);
    const sum = sumProcesses(procs);
    assert.equal(sum.rss_kb, 351_000);
    assert.equal(sum.cpu_ms, 5100);
    assert.deepEqual(sum.comms, ["bash", "claude", "kworker", "node"]);
  } finally {
    rmrf(root);
  }
});

test("processTree falls back to a ppid scan without children files", () => {
  const root = fakeProc({ processes: TREE });
  try {
    const procs = processTree(10, { procRoot: root, children: childLookup(root) });
    assert.deepEqual(procs.map((p) => p.pid).sort(), [10, 11, 12, 14]);
  } finally {
    rmrf(root);
  }
});

test("readCgroup sums RSS of the cgroup's processes and keeps memory.current beside it", () => {
  const root = fakeProc({ processes: TREE });
  const cg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-cg-"));
  try {
    fakeCgroup(cg, "/user.slice/u/team-up-x.service", {
      current: 400 * 1024 * 1024, peak: 500 * 1024 * 1024, procs: [11, 12], usageUsec: 7_000_000,
    });
    const r = readCgroup("/user.slice/u/team-up-x.service", { cgroupRoot: cg, procRoot: root });
    assert.equal(r.rss_kb, 350_000);
    assert.equal(r.cgroup_kb, 400 * 1024);
    assert.equal(r.cgroup_peak_kb, 500 * 1024);
    assert.equal(r.cpu_ms, 7000);
    assert.deepEqual(r.pids, [11, 12]);
    assert.equal(readCgroup("/missing", { cgroupRoot: cg, procRoot: root }), null);
  } finally {
    rmrf(root, cg);
  }
});
