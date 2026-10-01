import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parentRows, takeSample, workerRows } from "../../src/telemetry/sample.mjs";
import { BOOT, fakeCgroup, fakeProc, rmrf } from "./fake-proc.mjs";

const PROCS = [
  { pid: 100, ppid: 1, comm: "bash", rss_kb: 2000, children: [101] },
  { pid: 101, ppid: 100, comm: "claude", rss_kb: 400_000, children: [] },
  { pid: 200, ppid: 1, comm: "systemd-run", rss_kb: 3000, children: [] },
  { pid: 300, ppid: 1, comm: "codex", rss_kb: 250_000, children: [] },
];

const STATES = [
  { runId: "run-a", role: "code", runtime: { cli: "claude" }, worker: { tmux: "tu-a" } },
  {
    runId: "run-b", role: "review", worker: { tmux: "tu-b", cli: "codex" },
    sandbox: { kind: "systemd-run-user", unit: "team-up-run-b-x.service" },
  },
  // Session gone: no live worker, no row.
  { runId: "run-c", role: "code", worker: { tmux: "tu-c", cli: "claude" } },
  // Not started yet.
  { runId: "run-d", role: "code", worker: { tmux: null, cli: "claude" } },
];

const PANES = { "tu-a": [100], "tu-b": [200] };

test("takeSample records the machine and one row per live worker", async () => {
  const root = fakeProc({ processes: PROCS });
  const cg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-cg-"));
  try {
    fakeCgroup(cg, "/user.slice/team-up-run-b-x.service", { current: 300 * 1024 * 1024, procs: [300] });
    const sample = await takeSample({
      now: new Date("2026-10-01T10:00:00Z"),
      procRoot: root,
      cgroupRoot: cg,
      states: STATES,
      panePids: (s) => PANES[s] ?? [],
      unitCgroup: (unit) => (unit === "team-up-run-b-x.service" ? "/user.slice/team-up-run-b-x.service" : null),
      sessions: [{ cli: "claude", session_id: "p-1", pid: 100, tmux: { session: "main" } }],
    });
    assert.equal(sample.schema, "team-up.telemetry/v1");
    assert.equal(sample.at, "2026-10-01T10:00:00.000Z");
    assert.equal(sample.boot_id, BOOT);
    assert.equal(sample.mem.MemTotal, 16_000_000);
    assert.equal(sample.psi.memory.full.avg10, 0.5);
    assert.deepEqual(sample.workers.map((w) => [w.runId, w.source, w.rss_kb, w.cli]), [
      ["run-a", "tmux", 402_000, "claude"],
      // The worker itself, read from its unit, not the systemd-run client in the pane.
      ["run-b", "cgroup", 250_000, "codex"],
    ]);
    assert.equal(sample.workers[1].cgroup_kb, 300 * 1024);
    assert.equal(sample.team_up_rss_kb, 652_000);
    // Parents are listed, and stay out of the team-up total.
    assert.deepEqual(sample.parents, [
      { cli: "claude", session_id: "p-1", pid: 100, tmux: "main", rss_kb: 402_000, cpu_ms: 0, processes: 2 },
    ]);
  } finally {
    rmrf(root, cg);
  }
});

test("a sandboxed worker without a readable unit says its RSS is the pane only", () => {
  const root = fakeProc({ processes: PROCS });
  try {
    const rows = workerRows([
      { runId: "old", worker: { tmux: "tu-b" }, sandbox: { kind: "systemd-run-user" } },
    ], { procRoot: root, panePids: () => [200], unitCgroup: () => null });
    assert.equal(rows[0].source, "tmux");
    assert.equal(rows[0].rss_kb, 3000);
    assert.match(rows[0].note, /without a recorded unit/);
  } finally {
    rmrf(root);
  }
});

test("parentRows skips nothing and reads a gone process as empty", () => {
  const root = fakeProc({ processes: PROCS });
  try {
    const rows = parentRows([{ cli: "hermes", session_id: "h", pid: 999, tmux: null }], { procRoot: root });
    assert.deepEqual(rows, [{ cli: "hermes", session_id: "h", pid: 999, tmux: null, rss_kb: 0, cpu_ms: 0, processes: 0 }]);
  } finally {
    rmrf(root);
  }
});
