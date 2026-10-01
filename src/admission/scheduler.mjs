import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../json-store.mjs";
import { teamUpHome } from "../paths.mjs";

export const HEARTBEAT_TIMEOUT_MS = 120_000;
export const POLL_MS = 5_000;
// A resumed parent loads its transcript and re-spawns its watchers; there is
// no heartbeat to wait for, so it gets a fixed moment before the next start.
export const PARENT_SETTLE_MS = 15_000;
// How long a worker waits for admission before it is deferred.
export const ADMIT_WAIT_MS = 120_000;

/**
 * How many workers may run after a restart, by verdict. `workersLast` is the
 * count at the last sample before it (plan 1's restart report).
 *   team_up_suspected  half of what ran before, at least one
 *   unknown            no more than ran before
 *   anything else      what the machine holds
 */
export function resumeBudget({ verdict = null, maxWorkers, workersLast = null }) {
  if (verdict === "team_up_suspected") {
    const half = Math.floor((workersLast ?? 0) / 2);
    return Math.max(1, Math.min(maxWorkers, half));
  }
  if (verdict === "unknown" && workersLast != null) return Math.min(maxWorkers, workersLast);
  return maxWorkers;
}

/**
 * Start order: parents first (what the human talks to), then workers whose
 * run waits on a human answer, then the rest oldest first (most invested).
 */
export function orderQueue({ parents = [], workers = [] }) {
  const rank = (item) => (item.state.status === "waiting_human" ? 0 : 1);
  const sorted = [...workers].sort((a, b) =>
    rank(a) - rank(b) || String(a.state.createdAt).localeCompare(String(b.state.createdAt)));
  return [...parents, ...sorted];
}

export function resumeQueuePath(env = process.env) {
  return path.join(teamUpHome(env), "resume-queue.json");
}

export function readQueueStatus(file = resumeQueuePath()) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function itemLabel(item) {
  return item.kind === "parent" ? `parent ${item.key}` : `run ${item.state.runId}`;
}

/**
 * Start `items` one after another. Before each start after the first, wait
 * for the previous one to settle (its HEARTBEAT, its parent moment, its
 * death, or 120 s), then for `admit` to pass on a fresh sample. A worker that
 * is not admitted within ADMIT_WAIT_MS is handed to `defer`, and so is every
 * worker behind it: a machine that did not absorb one start will not absorb
 * the next. Parents are never deferred: the human's session comes back.
 *
 * With `slowStart: false` nothing waits and nothing is admitted: every item
 * starts in order, which is what `runs resume` did before.
 */
export async function runQueue(items, {
  start,
  admit = async () => ({ ok: true }),
  defer = () => {},
  heartbeatSince = () => false,
  alive = () => true,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => Date.now(),
  slowStart = true,
  onUpdate = () => {},
  pollMs = POLL_MS,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
  parentSettleMs = PARENT_SETTLE_MS,
  admitWaitMs = ADMIT_WAIT_MS,
} = {}) {
  const results = items.map((item) => ({ item, label: itemLabel(item), status: "queued" }));
  const update = () => onUpdate(results);
  let previous = null;
  let deferAll = null;
  update();

  async function settle(prev) {
    if (prev.result.item.kind === "parent") {
      await sleep(parentSettleMs);
      return "parent_settle";
    }
    while (clock() - prev.startedAt < heartbeatTimeoutMs) {
      if (heartbeatSince(prev.result.item, prev.startedAt)) return "heartbeat";
      if (!alive(prev.result.item)) return "dead";
      await sleep(pollMs);
    }
    return "timeout";
  }

  for (const result of results) {
    const { item } = result;
    if (item.kind === "worker" && deferAll) {
      result.status = "deferred";
      result.reason = deferAll;
      defer(item, { ok: false, reason: deferAll });
      update();
      continue;
    }
    if (slowStart && previous) {
      previous.result.settle = await settle(previous);
      previous = null;
      update();
    }
    if (slowStart && item.kind === "worker") {
      const deadline = clock() + admitWaitMs;
      let decision = await admit(item);
      while (!decision.ok && clock() < deadline) {
        result.status = "waiting_admission";
        result.reason = decision.reason;
        update();
        await sleep(pollMs);
        decision = await admit(item);
      }
      if (!decision.ok) {
        result.status = "deferred";
        result.reason = decision.reason;
        deferAll = decision.reason;
        defer(item, decision);
        update();
        continue;
      }
    }
    result.started_at = new Date(clock()).toISOString();
    try {
      await start(item);
      result.status = "started";
      result.reason = null;
      previous = { result, startedAt: clock() };
    } catch (error) {
      // A start that failed does not hold the queue: nothing is running to wait for.
      result.status = "failed";
      result.error = error.message || String(error);
    }
    update();
  }
  if (slowStart && previous && previous.result.item.kind === "worker") {
    // Not waited for: nothing comes after it. Recorded as such.
    previous.result.settle = "last";
  }
  update();
  return results;
}

/** What `runs resume` writes while its queue runs, for a second caller to read. */
export function writeQueueStatus(file, { pid = process.pid, startedAt, results, done = false }) {
  atomicWriteJson(file, {
    pid,
    started_at: startedAt,
    updated_at: new Date().toISOString(),
    done,
    items: results.map((r) => ({
      label: r.label,
      status: r.status,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.started_at ? { started_at: r.started_at } : {}),
      ...(r.settle ? { settle: r.settle } : {}),
    })),
  });
}

export function formatQueueStatus(status) {
  if (!status) return ["no resume queue recorded"];
  const lines = [`resume queue (pid ${status.pid}, started ${status.started_at}${status.done ? ", finished" : ""}):`];
  for (const item of status.items ?? []) {
    const extra = item.reason ?? item.error ?? item.settle ?? "";
    lines.push(`  ${item.status.padEnd(17)} ${item.label}${extra ? `  (${extra})` : ""}`);
  }
  return lines;
}
