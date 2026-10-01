import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HEARTBEAT_TIMEOUT_MS,
  PARENT_SETTLE_MS,
  formatQueueStatus,
  orderQueue,
  readQueueStatus,
  resumeBudget,
  runQueue,
  writeQueueStatus,
} from "../../src/admission/scheduler.mjs";

function fakeClock() {
  let now = 0;
  return {
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    advance: (ms) => { now += ms; },
    get now() { return now; },
  };
}

const worker = (id, { status = "watching", createdAt = `2026-10-01T09:0${id}:00Z` } = {}) =>
  ({ kind: "worker", state: { runId: `r${id}`, status, createdAt }, action: { kind: "spawn_worker", tmux: `t${id}`, cli: "codex" } });
const parent = (key) => ({ kind: "parent", key });

test("resumeBudget by verdict", () => {
  assert.equal(resumeBudget({ verdict: "team_up_suspected", maxWorkers: 8, workersLast: 6 }), 3);
  assert.equal(resumeBudget({ verdict: "team_up_suspected", maxWorkers: 2, workersLast: 6 }), 2);
  assert.equal(resumeBudget({ verdict: "team_up_suspected", maxWorkers: 8, workersLast: 1 }), 1);
  assert.equal(resumeBudget({ verdict: "unknown", maxWorkers: 8, workersLast: 4 }), 4);
  assert.equal(resumeBudget({ verdict: "unknown", maxWorkers: 3, workersLast: 4 }), 3);
  assert.equal(resumeBudget({ verdict: "unknown", maxWorkers: 3, workersLast: null }), 3);
  assert.equal(resumeBudget({ verdict: "clean_shutdown", maxWorkers: 5, workersLast: 9 }), 5);
  assert.equal(resumeBudget({ verdict: "other_cause", maxWorkers: 5, workersLast: 1 }), 5);
  assert.equal(resumeBudget({ maxWorkers: 5 }), 5);
});

test("orderQueue: parents, then waiting_human, then oldest first", () => {
  const items = orderQueue({
    parents: [parent("p")],
    workers: [worker(3), worker(1), worker(2, { status: "waiting_human" })],
  });
  assert.deepEqual(items.map((i) => i.key ?? i.state.runId), ["p", "r2", "r1", "r3"]);
});

test("runQueue waits for each worker's heartbeat before the next start", async () => {
  const c = fakeClock();
  const started = [];
  const beats = new Map();
  const results = await runQueue([parent("p"), worker(1), worker(2)], {
    ...c,
    start: async (item) => {
      started.push([item.key ?? item.state.runId, c.now]);
      if (item.kind === "worker") beats.set(item.state.runId, c.now + 15_000);
    },
    heartbeatSince: (item) => c.now >= beats.get(item.state.runId),
  });
  assert.deepEqual(started, [["p", 0], ["r1", PARENT_SETTLE_MS], ["r2", PARENT_SETTLE_MS + 15_000]]);
  assert.deepEqual(results.map((r) => r.settle ?? null), ["parent_settle", "heartbeat", "last"]);
});

test("runQueue gives up on a silent worker after 120 s and does not stall on a dead one", async () => {
  const c = fakeClock();
  const started = [];
  const results = await runQueue([worker(1), worker(2), worker(3)], {
    ...c,
    start: async (item) => started.push([item.state.runId, c.now]),
    alive: (item) => item.state.runId !== "r2",
  });
  assert.deepEqual(started, [["r1", 0], ["r2", HEARTBEAT_TIMEOUT_MS], ["r3", HEARTBEAT_TIMEOUT_MS]]);
  assert.deepEqual(results.map((r) => r.settle), ["timeout", "dead", "last"]);
});

test("runQueue defers a worker admission keeps refusing, and every worker after it", async () => {
  const c = fakeClock();
  const started = [];
  const deferred = [];
  let admitted = 0;
  const results = await runQueue([parent("p"), worker(1), worker(2), worker(3)], {
    ...c,
    start: async (item) => started.push(item.key ?? item.state.runId),
    heartbeatSince: () => true,
    admit: async () => (admitted++ < 1 ? { ok: true } : { ok: false, reason: "MemAvailable low" }),
    defer: (item, decision) => deferred.push([item.state.runId, decision.reason]),
  });
  assert.deepEqual(started, ["p", "r1"]);
  assert.deepEqual(deferred, [["r2", "MemAvailable low"], ["r3", "MemAvailable low"]]);
  assert.deepEqual(results.map((r) => r.status), ["started", "started", "deferred", "deferred"]);
});

test("runQueue starts a worker once admission passes within the wait", async () => {
  const c = fakeClock();
  const started = [];
  let calls = 0;
  await runQueue([worker(1)], {
    ...c,
    start: async (item) => started.push([item.state.runId, c.now]),
    admit: async () => (++calls < 3 ? { ok: false, reason: "pressure" } : { ok: true }),
  });
  assert.deepEqual(started, [["r1", 10_000]]);
});

test("a failed start does not hold the queue, and without slow start nothing waits", async () => {
  const c = fakeClock();
  const results = await runQueue([worker(1), worker(2)], {
    ...c,
    slowStart: false,
    admit: async () => ({ ok: false, reason: "never asked" }),
    start: async (item) => { if (item.state.runId === "r1") throw new Error("tmux failed"); },
  });
  assert.equal(c.now, 0);
  assert.deepEqual(results.map((r) => [r.status, r.error ?? null]), [["failed", "tmux failed"], ["started", null]]);
});

test("the queue status file is what a second resume prints", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-queue-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "resume-queue.json");
  const c = fakeClock();
  await runQueue([worker(1), worker(2)], {
    ...c,
    start: async () => {},
    heartbeatSince: () => true,
    onUpdate: (results) => writeQueueStatus(file, { startedAt: "2026-10-01T10:00:00Z", results, pid: 42 }),
  });
  const lines = formatQueueStatus(readQueueStatus(file));
  assert.match(lines[0], /pid 42/);
  assert.match(lines[1], /started\s+run r1\s+\(heartbeat\)/);
  assert.deepEqual(formatQueueStatus(null), ["no resume queue recorded"]);
});
