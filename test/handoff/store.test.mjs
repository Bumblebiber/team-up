import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildHandoffFilename,
  closeHandoff,
  FORGOTTEN_HANDOFF_MS,
  handoffGcDecision,
  planHandoffGc,
  gcHandoffs,
  listOpenHandoffs,
  refuseCloseOutsideStore,
  resolveHandoffForSpawn,
  successorPrompt,
} from "../../src/handoff/store.mjs";
import { handoffsDir, handoffsDoneDir } from "../../src/paths.mjs";
import { diagnose } from "../../src/doctor.mjs";

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-handoff-"));
  const env = { TEAM_UP_HOME: home };
  try {
    return fn(home, env);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("buildHandoffFilename uses UTC stamp, label, and random suffix", () => {
  const now = new Date("2026-09-23T06:09:09.123Z");
  const name = buildHandoffFilename({ now, label: "planner", random: () => "a3f2" });
  assert.equal(name, "20260923T060909Z-planner-a3f2.md");
});

test("legacy HANDOFF.md is moved into the store with mode 0600", () => {
  withHome((home, env) => {
    const task = fs.mkdtempSync(path.join(home, "task-"));
    const legacy = path.join(task, "HANDOFF.md");
    fs.writeFileSync(legacy, "# handoff\n", "utf8");

    const stored = resolveHandoffForSpawn({
      dir: task,
      label: "planner",
      env,
      now: new Date("2026-09-23T06:09:09.000Z"),
    });

    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.existsSync(stored), true);
    assert.match(stored, new RegExp(`^${handoffsDir(env).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
    assert.equal((fs.statSync(stored).mode & 0o777), 0o600);
    assert.equal(fs.readFileSync(stored, "utf8"), "# handoff\n");
  });
});

test("successor prompt names the absolute store path and --close", () => {
  const file = "/tmp/.team-up/handoffs/20260923T060909Z-planner-a3f2.md";
  const prompt = successorPrompt(file);
  assert.match(prompt, new RegExp(`Read ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(prompt, /--close/);
  assert.ok(prompt.includes(file));
});

test("close moves open handoff to done/ and appends closed-at block", () => {
  withHome((home, env) => {
    const openDir = handoffsDir(env);
    fs.mkdirSync(openDir, { recursive: true });
    const openPath = path.join(openDir, "20260923T060909Z-planner-a3f2.md");
    fs.writeFileSync(openPath, "# work\n", { mode: 0o600 });

    const result = closeHandoff(openPath, {
      env,
      note: "done",
      now: new Date("2026-09-23T12:00:00.000Z"),
    });

    assert.equal(result.status, "closed");
    assert.equal(fs.existsSync(openPath), false);
    const donePath = path.join(handoffsDoneDir(env), "20260923T060909Z-planner-a3f2.md");
    assert.equal(result.path, donePath);
    const body = fs.readFileSync(donePath, "utf8");
    assert.match(body, /closed-at: 2026-09-23T12:00:00.000Z/);
    assert.match(body, /note: done/);
  });
});

test("close is idempotent when the handoff is already in done/", () => {
  withHome((home, env) => {
    const doneDir = handoffsDoneDir(env);
    fs.mkdirSync(doneDir, { recursive: true });
    const donePath = path.join(doneDir, "20260923T060909Z-planner-a3f2.md");
    fs.writeFileSync(donePath, "# closed\n", { mode: 0o600 });
    const openPath = path.join(handoffsDir(env), "20260923T060909Z-planner-a3f2.md");

    const result = closeHandoff(openPath, { env });
    assert.equal(result.status, "already_closed");
    assert.equal(result.path, donePath);
  });
});

test("close refuses paths outside the handoff store", () => {
  withHome((home, env) => {
    const outside = path.join(home, "escape.md");
    fs.writeFileSync(outside, "nope\n");
    assert.throws(
      () => refuseCloseOutsideStore(outside, env),
      /path escapes store root/
    );
    assert.throws(
      () => closeHandoff(path.join(handoffsDir(env), "../escape.md"), { env }),
      /path escapes store root/
    );
  });
});

test("handoffGcDecision at 13 days retains and at 15 days deletes", () => {
  const nowMs = Date.parse("2026-09-23T00:00:00.000Z");
  const thirteen = nowMs - 13 * 24 * 60 * 60 * 1000;
  const fifteen = nowMs - 15 * 24 * 60 * 60 * 1000;
  assert.equal(handoffGcDecision({ mtimeMs: thirteen, nowMs, retentionDays: 14 }), false);
  assert.equal(handoffGcDecision({ mtimeMs: fifteen, nowMs, retentionDays: 14 }), true);
});

test("handoffGcDecision honours custom retention", () => {
  const nowMs = Date.parse("2026-09-23T00:00:00.000Z");
  const tenDays = nowMs - 10 * 24 * 60 * 60 * 1000;
  assert.equal(handoffGcDecision({ mtimeMs: tenDays, nowMs, retentionDays: 7 }), true);
  assert.equal(handoffGcDecision({ mtimeMs: tenDays, nowMs, retentionDays: 14 }), false);
});

test("planHandoffGc selects only stale entries", () => {
  const nowMs = Date.parse("2026-09-23T00:00:00.000Z");
  const stale = nowMs - 20 * 24 * 60 * 60 * 1000;
  const fresh = nowMs - 2 * 24 * 60 * 60 * 1000;
  const planned = planHandoffGc({
    nowMs,
    retentionDays: 14,
    entries: [
      { path: "/h/old.md", mtimeMs: stale },
      { path: "/h/new.md", mtimeMs: fresh },
    ],
  });
  assert.deepEqual(planned, ["/h/old.md"]);
});

test("gcHandoffs deletes from open and done directories", () => {
  withHome((home, env) => {
    const openDir = handoffsDir(env);
    const doneDir = handoffsDoneDir(env);
    fs.mkdirSync(openDir, { recursive: true });
    fs.mkdirSync(doneDir, { recursive: true });
    const oldOpen = path.join(openDir, "old-open.md");
    const oldDone = path.join(doneDir, "old-done.md");
    const fresh = path.join(openDir, "fresh.md");
    const now = new Date("2026-09-23T00:00:00.000Z");
    const staleAt = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
    fs.writeFileSync(oldOpen, "x\n");
    fs.writeFileSync(oldDone, "x\n");
    fs.writeFileSync(fresh, "x\n");
    fs.utimesSync(oldOpen, staleAt, staleAt);
    fs.utimesSync(oldDone, staleAt, staleAt);

    const report = gcHandoffs({ env, now, retentionDays: 14 });
    assert.deepEqual(report.deleted.sort(), [oldDone, oldOpen].sort());
    assert.equal(fs.existsSync(fresh), true);
  });
});

test("doctor reports forgotten open handoffs at 49h but not 47h", () => {
  withHome((home, env) => {
    const openDir = handoffsDir(env);
    fs.mkdirSync(openDir, { recursive: true });
    const stalePath = path.join(openDir, "20260921T000000Z-planner-abcd.md");
    const freshPath = path.join(openDir, "20260922T010000Z-planner-efgh.md");
    fs.writeFileSync(stalePath, "# stale\n");
    fs.writeFileSync(freshPath, "# fresh\n");
    const now = Date.now();
    fs.utimesSync(
      stalePath,
      new Date(now - 49 * 60 * 60 * 1000),
      new Date(now - 49 * 60 * 60 * 1000)
    );
    fs.utimesSync(
      freshPath,
      new Date(now - 47 * 60 * 60 * 1000),
      new Date(now - 47 * 60 * 60 * 1000)
    );

    const report = diagnose(env);
    const forgotten = report.findings.filter((f) => f.kind === "forgotten_handoff");
    assert.equal(forgotten.length, 1);
    assert.equal(forgotten[0].path, stalePath);
    assert.ok(forgotten[0].age_hours >= 48);
  });
});

test("listOpenHandoffs uses the 48h threshold", () => {
  withHome((home, env) => {
    const openDir = handoffsDir(env);
    fs.mkdirSync(openDir, { recursive: true });
    const stalePath = path.join(openDir, "stale.md");
    const freshPath = path.join(openDir, "fresh.md");
    fs.writeFileSync(stalePath, "x\n");
    fs.writeFileSync(freshPath, "x\n");
    const now = Date.parse("2026-09-23T00:00:00.000Z");
    fs.utimesSync(
      stalePath,
      new Date(now - FORGOTTEN_HANDOFF_MS - 60_000),
      new Date(now - FORGOTTEN_HANDOFF_MS - 60_000)
    );
    fs.utimesSync(
      freshPath,
      new Date(now - FORGOTTEN_HANDOFF_MS + 60_000),
      new Date(now - FORGOTTEN_HANDOFF_MS + 60_000)
    );
    const hits = listOpenHandoffs(env, { now });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, stalePath);
  });
});
