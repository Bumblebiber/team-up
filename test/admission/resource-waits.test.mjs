import "../helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, loadState, mailboxDir, setStatus } from "../../src/runs/runs.mjs";
import { deferForResources, listDueWaits, resumeDueWaits, RESOURCE_RETRY_MS } from "../../src/supervisor/waits.mjs";

async function withTempEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-res-wait-"));
  const prev = { TEAM_UP_HOME: process.env.TEAM_UP_HOME, TEAM_UP_RUNS: process.env.TEAM_UP_RUNS };
  process.env.TEAM_UP_HOME = home;
  process.env.TEAM_UP_RUNS = path.join(home, "runs");
  try {
    return await fn(home);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function parkedRun(status = "watching") {
  const run = createRun({
    cwd: "/tmp/p",
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "team-up-w", sessionId: "s-1" },
    prompt: "x",
  });
  setStatus(run.runId, status);
  const action = { kind: "spawn_worker", tmux: "team-up-w", cli: "codex", sessionId: "s-1", cwd: "/tmp/p" };
  return { runId: run.runId, action };
}

test("a resources wait is postponed while admission refuses and replays its action once admitted", async () => {
  await withTempEnv(async () => {
    const t0 = new Date("2026-10-01T10:00:00Z");
    const { runId, action } = parkedRun("waiting_human");
    deferForResources({ runId, admission: { reason: "budget 3" }, verdict: "team_up_suspected", action, now: t0 });
    let state = loadState(runId);
    assert.equal(state.status, "waiting_capacity");
    assert.equal(state.capacity.reason, "resources");
    assert.equal(state.capacity.resume_status, "waiting_human");
    assert.equal(state.capacity.resume_mailbox_status, "waiting_human");
    assert.deepEqual(state.capacity.admission, { reason: "budget 3", verdict: "team_up_suspected" });
    assert.equal(fs.readFileSync(path.join(mailboxDir(runId), "STATUS"), "utf8").trim(), "waiting_capacity");

    assert.deepEqual(listDueWaits({ now: t0.toISOString() }), []);
    const due = new Date(t0.getTime() + RESOURCE_RETRY_MS).toISOString();
    assert.deepEqual(listDueWaits({ now: due, reason: "resources" }), [runId]);
    assert.deepEqual(listDueWaits({ now: due, reason: "quota" }), []);

    const executed = [];
    const refused = await resumeDueWaits({
      now: due,
      admit: async () => ({ ok: false, reason: "swap use rising" }),
      executeAction: (a) => executed.push(a),
    });
    assert.equal(refused[0].resumed, false);
    assert.match(refused[0].reason, /swap use rising/);
    assert.equal(executed.length, 0);
    state = loadState(runId);
    assert.equal(state.capacity.resume_not_before, new Date(Date.parse(due) + RESOURCE_RETRY_MS).toISOString());
    assert.deepEqual(listDueWaits({ now: due }), []);

    const later = state.capacity.resume_not_before;
    const ok = await resumeDueWaits({
      now: later,
      admit: async () => ({ ok: true }),
      executeAction: (a, st) => executed.push([a, st.runId]),
    });
    assert.equal(ok[0].resumed, true);
    assert.deepEqual(executed, [[action, runId]]);
    state = loadState(runId);
    assert.equal(state.status, "waiting_human");
    assert.equal(state.capacity.auto_resume, false);
    assert.equal(fs.readFileSync(path.join(mailboxDir(runId), "STATUS"), "utf8").trim(), "waiting_human");
    assert.deepEqual(listDueWaits({ now: "2099-01-01T00:00:00Z" }), []);
  });
});

test("one resources wait starts per pass, and a failed start is retried later", async () => {
  await withTempEnv(async () => {
    const t0 = new Date("2026-10-01T10:00:00Z");
    const a = parkedRun();
    const b = parkedRun();
    deferForResources({ runId: a.runId, admission: { reason: "r" }, action: a.action, now: t0 });
    deferForResources({ runId: b.runId, admission: { reason: "r" }, action: b.action, now: t0 });
    const due = new Date(t0.getTime() + RESOURCE_RETRY_MS).toISOString();
    const started = [];
    const results = await resumeDueWaits({
      now: due,
      admit: async () => ({ ok: true }),
      executeAction: (action, st) => {
        if (st.runId === a.runId) throw new Error("tmux: duplicate session");
        started.push(st.runId);
      },
    });
    const byRun = Object.fromEntries(results.map((r) => [r.runId, r]));
    assert.equal(byRun[a.runId].reason, "start_worker_failed");
    assert.equal(byRun[b.runId].resumed, true);
    assert.deepEqual(started, [b.runId]);
    assert.equal(loadState(a.runId).status, "waiting_capacity");
    assert.equal(loadState(b.runId).status, "watching");

    const c = parkedRun();
    const d = parkedRun();
    deferForResources({ runId: c.runId, admission: { reason: "r" }, action: c.action, now: t0 });
    deferForResources({ runId: d.runId, admission: { reason: "r" }, action: d.action, now: t0 });
    const pass = await resumeDueWaits({
      now: "2026-10-01T11:00:00Z",
      admit: async () => ({ ok: true }),
      executeAction: () => {},
    });
    assert.equal(pass.filter((r) => r.resumed).length, 1);
    assert.equal(pass.filter((r) => r.reason === "one_start_per_pass").length, 2);
  });
});
