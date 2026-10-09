// A dispatch records its routing decision on the run: which cell it chose,
// every cell it skipped and why, and whether the usage behind the choice was
// refreshed. Until now only worker {cli, model} survived and the skipped list
// went to stdout, so no run could show that gating routed around a limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNS = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pick-record-"));
process.env.TEAM_UP_RUNS = RUNS;

const { spawnInTmux } = await import("../../src/roster/roster.mjs");
const { createRun, loadState } = await import("../../src/runs/runs.mjs");

const ROSTER = {
  clis: {
    claude: { cmd: ["claude", "--model", "{model}", "{prompt}"] },
    codex: { cmd: ["codex", "--model", "{model}", "-c", "model_reasoning_effort={effort}", "{prompt}"] },
  },
  models: {
    a: { provider: "anthropic", cli: ["claude"] },
    b: { provider: "openai", cli: ["codex"], effort: "high" },
  },
  roles: { implementer: { chain: ["claude:a", "codex:b"] } },
};

const PARENT = { cli: "manual", attach: "manual" };

function windows(at, { claude5h = 0.9, codexWeekly = 0.1 } = {}) {
  const updated_at = new Date(at).toISOString();
  return {
    windows: {
      "claude:5h": { used: claude5h, updated_at },
      "codex:weekly": { used: codexWeekly, updated_at },
    },
  };
}

function quiet(fn) {
  const { log, error } = console;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = log;
      console.error = error;
    })
    .then((value) => ({ value, lines }));
}

function dispatch(overrides = {}) {
  const spawned = [];
  return quiet(() =>
    spawnInTmux({
      roster: ROSTER,
      role: "implementer",
      dir: RUNS,
      prompt: "work",
      detectParent: () => PARENT,
      spawn: async (args) => {
        // Written before the worker starts: a spawn that fails still leaves
        // the decision behind.
        spawned.push({ ...args, picks: loadState(args.runId)?.picks });
        return { session: "s" };
      },
      ...overrides,
    })
  ).then(({ lines }) => ({ spawned, lines }));
}

test("a dispatch records the chosen cell and the cells it skipped, before spawning", async () => {
  const { spawned } = await dispatch({ usageSnapshot: windows(Date.now()) });
  assert.equal(spawned.length, 1);
  const [record] = spawned[0].picks;
  assert.equal(record.cli, "codex");
  assert.equal(record.model, "b");
  assert.equal(record.effort, "high");
  assert.equal(record.pinned, false);
  assert.deepEqual(record.skipped, [{ model: "claude:a", reason: "window claude:5h at 90%" }]);
  assert.equal(record.refresh, null);
  assert.ok(Date.parse(record.at) > 0);
  assert.deepEqual(loadState(spawned[0].runId).worker.cli, "codex");
});

test("a refreshed dispatch records the refresh and the choice made on fresh usage", async () => {
  const stale = windows(Date.now() - 3_600_000, { claude5h: 0.9, codexWeekly: 0.1 });
  const { spawned } = await dispatch({
    usageSnapshot: stale,
    refreshUsage: async () => ({ ok: true }),
    readUsage: () => windows(Date.now(), { claude5h: 0.9, codexWeekly: 0.2 }),
  });
  const [record] = spawned[0].picks;
  assert.equal(record.refresh, "ok");
  assert.equal(record.model, "b");
  assert.deepEqual(record.skipped.map((s) => s.model), ["claude:a"]);
});

test("a failed refresh is recorded as such, whether reported or thrown", async () => {
  const stale = windows(Date.now() - 3_600_000);
  for (const refreshUsage of [
    async () => ({ ok: false, reason: "timeout" }),
    async () => {
      throw new Error("collector crashed");
    },
  ]) {
    const { spawned } = await dispatch({ usageSnapshot: stale, refreshUsage });
    assert.equal(spawned[0].picks[0].refresh, "failed");
    assert.equal(spawned[0].picks[0].model, "b");
  }
});

test("a pinned dispatch is recorded as pinned", async () => {
  const { spawned } = await dispatch({ usageSnapshot: windows(Date.now()), modelPin: "codex:b" });
  const [record] = spawned[0].picks;
  assert.equal(record.pinned, true);
  assert.equal(record.model, "b");
  assert.deepEqual(record.skipped, []);
});

test("re-dispatching a run appends to its pick history and keeps the last 10", async () => {
  const run = createRun({
    cwd: RUNS, role: "implementer", parent: PARENT, worker: { cli: "codex", model: "b" }, prompt: "work",
  });
  for (let i = 0; i < 12; i++) {
    await dispatch({ usageSnapshot: windows(Date.now()), runId: run.runId });
  }
  const picks = loadState(run.runId).picks;
  assert.equal(picks.length, 10);
  assert.ok(picks.every((p) => p.model === "b"));
});

test("a record that cannot be written warns and still dispatches", async () => {
  const { spawned, lines } = await dispatch({
    usageSnapshot: windows(Date.now()),
    createRun: () => ({ runId: "20991231T235959Z-none" }),
  });
  assert.equal(spawned.length, 1);
  assert.ok(lines.some((l) => /routing decision not recorded on run 20991231T235959Z-none/.test(l)), lines.join("\n"));
});

test("dispatch refuses a specialist run instead of starting it outside its capsule", async () => {
  const run = createRun({ cwd: RUNS, role: "specialist:coding.codey", parent: PARENT, worker: { cli: "claude" }, prompt: "x" });
  const exit = process.exit;
  let code = null;
  process.exit = (c) => { code = c; throw new Error("exit"); };
  let spawned;
  try {
    ({ spawned } = await dispatch({ runId: run.runId }).catch(() => ({ spawned: [] })));
  } finally {
    process.exit = exit;
  }
  assert.equal(code, 5);
  assert.deepEqual(spawned, []);
});
