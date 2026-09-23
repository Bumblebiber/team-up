import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildHandoffFilename,
  closeHandoff,
  FORGOTTEN_HANDOFF_MS,
  gcHandoffs,
  handoffGcDecision,
  listOpenHandoffs,
  listUnreadableOpenHandoffs,
  planHandoffGc,
  readHandoffRetentionDays,
  resolveHandoffForSpawn,
  successorPrompt,
} from "../../src/handoff/store.mjs";
import { handoffsDir, handoffsDoneDir } from "../../src/paths.mjs";
import { diagnose } from "../../src/doctor.mjs";
import { gcRuns } from "../../src/runs/gc.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROSTER_BIN = path.join(ROOT, "src/roster/roster.mjs");

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

test("handoff store directory is created with mode 0700", () => {
  withHome((home, env) => {
    const task = fs.mkdtempSync(path.join(home, "task-"));
    fs.writeFileSync(path.join(task, "HANDOFF.md"), "# handoff\n", "utf8");
    resolveHandoffForSpawn({ dir: task, label: "planner", env });
    assert.equal((fs.statSync(handoffsDir(env)).mode & 0o777), 0o700);
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

test("close is idempotent when passed the open path while only done copy exists", () => {
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

test("finding 1: close with done path is idempotent and does not delete the record", () => {
  withHome((home, env) => {
    const doneDir = handoffsDoneDir(env);
    fs.mkdirSync(doneDir, { recursive: true });
    const donePath = path.join(doneDir, "20260923T060909Z-planner-a3f2.md");
    const body = "# closed\n---\nclosed-at: 2026-09-23T06:00:00.000Z\n";
    fs.writeFileSync(donePath, body, { mode: 0o600 });

    const result = closeHandoff(donePath, { env });
    assert.equal(result.status, "already_closed");
    assert.equal(result.path, donePath);
    assert.equal(fs.readFileSync(donePath, "utf8"), body);
  });
});

test("close refuses paths outside the handoff store", () => {
  withHome((home, env) => {
    const outside = path.join(home, "escape.md");
    fs.writeFileSync(outside, "nope\n");
    assert.throws(
      () => closeHandoff(outside, { env }),
      /path escapes store root/
    );
    assert.throws(
      () => closeHandoff(path.join(handoffsDir(env), "../escape.md"), { env }),
      /path escapes store root/
    );
  });
});

test("close refuses symlinks instead of copying their target into done/", () => {
  withHome((home, env) => {
    const openDir = handoffsDir(env);
    fs.mkdirSync(openDir, { recursive: true });
    const secret = path.join(home, "secret.md");
    fs.writeFileSync(secret, "secret\n", { mode: 0o600 });
    const linkPath = path.join(openDir, "20260923T060909Z-planner-link.md");
    fs.symlinkSync(secret, linkPath);

    assert.throws(() => closeHandoff(linkPath, { env }), /not a regular file/);
    assert.equal(fs.readFileSync(secret, "utf8"), "secret\n");
    assert.equal(fs.existsSync(linkPath), true);
  });
});

test("resolveHandoffForSpawn reports missing --handoff-file path", () => {
  withHome((home, env) => {
    const task = fs.mkdtempSync(path.join(home, "task-"));
    const missing = path.join(task, "nope.md");
    assert.throws(
      () => resolveHandoffForSpawn({ dir: task, handoffFile: missing, label: "planner", env }),
      /handoff file not found:/
    );
  });
});

test("resolveHandoffForSpawn error names HANDOFF.md and --handoff-file only", () => {
  withHome((home, env) => {
    const task = fs.mkdtempSync(path.join(home, "task-"));
    assert.throws(
      () => resolveHandoffForSpawn({ dir: task, label: "planner", env }),
      (error) => {
        assert.match(error.message, /HANDOFF\.md/);
        assert.match(error.message, /--handoff-file/);
        assert.doesNotMatch(error.message, /create a file under/);
        return true;
      }
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

test("readHandoffRetentionDays clamps invalid roster values to default", () => {
  const warnings = [];
  assert.equal(readHandoffRetentionDays({ limits: { handoff_retention_days: 0 } }, { warn: (m) => warnings.push(m) }), 14);
  assert.equal(readHandoffRetentionDays({ limits: { handoff_retention_days: -1 } }, { warn: (m) => warnings.push(m) }), 14);
  assert.equal(readHandoffRetentionDays({ limits: { handoff_retention_days: "abc" } }, { warn: (m) => warnings.push(m) }), 14);
  assert.equal(readHandoffRetentionDays({ limits: { handoff_retention_days: 21 } }), 21);
  assert.equal(warnings.length, 3);
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

test("finding 2: gcHandoffs dry-run reports deletions without unlinking", () => {
  withHome((home, env) => {
    const openDir = handoffsDir(env);
    fs.mkdirSync(openDir, { recursive: true });
    const oldOpen = path.join(openDir, "old-open.md");
    const now = new Date("2026-09-23T00:00:00.000Z");
    const staleAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    fs.writeFileSync(oldOpen, "x\n");
    fs.utimesSync(oldOpen, staleAt, staleAt);

    const report = gcHandoffs({ env, now, retentionDays: 14, dryRun: true });
    assert.deepEqual(report.deleted, [oldOpen]);
    assert.equal(report.dryRun, true);
    assert.equal(fs.existsSync(oldOpen), true);
  });
});

test("finding 3: gcRuns with invalid retention does not delete fresh handoffs", () => {
  withHome((home, env) => {
    const rosterPath = path.join(home, "roster.json");
    fs.writeFileSync(
      rosterPath,
      JSON.stringify({
        clis: { claude: { cmd: ["claude", "{prompt}"] } },
        models: { "model-a": { provider: "anthropic", cli: ["claude"] } },
        roles: { planner: { chain: ["model-a"] } },
        limits: { handoff_retention_days: 0 },
      }),
    );
    const openDir = handoffsDir(env);
    fs.mkdirSync(openDir, { recursive: true });
    const fresh = path.join(openDir, "written-one-second-ago.md");
    fs.writeFileSync(fresh, "x\n");

    const prevRoster = process.env.TEAM_UP_ROSTER;
    process.env.TEAM_UP_ROSTER = rosterPath;
    process.env.TEAM_UP_HOME = home;
    try {
      const report = gcRuns({ now: new Date(), states: [], listSessions: () => [], dryRun: false });
      assert.equal(fs.existsSync(fresh), true);
      assert.deepEqual(report.handoffs.deleted, []);
      assert.equal(report.handoffs.retentionDays, 14);
    } finally {
      if (prevRoster === undefined) delete process.env.TEAM_UP_ROSTER;
      else process.env.TEAM_UP_ROSTER = prevRoster;
    }
  });
});

test("finding 4: dangling symlink does not break listOpenHandoffs, doctor, or gcHandoffs", () => {
  withHome((home, env) => {
    const openDir = handoffsDir(env);
    fs.mkdirSync(openDir, { recursive: true });
    const real = path.join(openDir, "real.md");
    const dangling = path.join(openDir, "dangling.md");
    fs.writeFileSync(real, "# real\n");
    fs.symlinkSync(path.join(openDir, "missing-target.md"), dangling);

    const hits = listOpenHandoffs(env);
    assert.equal(hits.length, 0);
    const unreadable = listUnreadableOpenHandoffs(env);
    assert.equal(unreadable.length, 1);
    assert.equal(unreadable[0].path, dangling);

    const report = diagnose({ ...process.env, ...env });
    const unreadableFinding = report.findings.filter((f) => f.kind === "unreadable_handoff");
    assert.equal(unreadableFinding.length, 1);
    assert.equal(unreadableFinding[0].path, dangling);

    const now = new Date("2099-01-01T00:00:00.000Z");
    fs.utimesSync(real, now, now);
    const gcReport = gcHandoffs({ env, now, retentionDays: 14 });
    assert.equal(fs.existsSync(real), true);
    assert.equal(gcReport.skipped.length, 1);
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

    const report = diagnose({ ...process.env, ...env });
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

test("finding 5: handoff CLI prints stored path when spawn fails", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-handoff-cli-"));
  const task = fs.mkdtempSync(path.join(home, "task-"));
  const rosterPath = path.join(home, "roster.json");
  fs.writeFileSync(
    rosterPath,
    JSON.stringify({
      clis: { claude: { cmd: ["claude", "{prompt}"] } },
      models: {
        "model-a": { provider: "anthropic", cli: ["claude"] },
      },
      roles: { planner: { chain: ["model-a"] } },
    }),
  );
  fs.writeFileSync(path.join(task, "HANDOFF.md"), "# handoff\n", "utf8");
  const usagePath = path.join(home, "usage.json");
  const now = new Date().toISOString();
  fs.writeFileSync(
    usagePath,
    JSON.stringify({
      windows: {
        "anthropic:session": { used: 1, updated: now },
      },
      providers: { anthropic: { used: 1 } },
    }),
  );

  try {
    const stderr = execFileSync(
      process.execPath,
      [ROSTER_BIN, "handoff", "--role", "planner", "--dir", task],
      {
        env: {
          ...process.env,
          TEAM_UP_HOME: home,
          TEAM_UP_ROSTER: rosterPath,
          TEAM_UP_USAGE: usagePath,
        },
        encoding: "utf8",
      },
    );
    assert.fail(`expected non-zero exit, got: ${stderr}`);
  } catch (error) {
    assert.equal(error.status, 2);
    const combined = `${error.stdout || ""}${error.stderr || ""}`;
    assert.match(combined, /handoff stored:/);
    assert.match(combined, /chain exhausted/);
    assert.equal(fs.existsSync(path.join(task, "HANDOFF.md")), false);
    const stored = fs.readdirSync(path.join(home, "handoffs")).filter((n) => n.endsWith(".md"));
    assert.equal(stored.length, 1);
    assert.match(combined, new RegExp(stored[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("finding 6: handoff CLI surfaces --handoff-file not found", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-handoff-cli-"));
  const task = fs.mkdtempSync(path.join(home, "task-"));
  const rosterPath = path.join(home, "roster.json");
  fs.writeFileSync(
    rosterPath,
    JSON.stringify({
      clis: { claude: { cmd: ["claude", "{prompt}"] } },
      models: { "model-a": { provider: "anthropic", cli: ["claude"] } },
      roles: { planner: { chain: ["model-a"] } },
    }),
  );
  const missing = path.join(task, "nope.md");

  try {
    execFileSync(
      process.execPath,
      [ROSTER_BIN, "handoff", "--role", "planner", "--dir", task, "--handoff-file", missing],
      {
        env: {
          ...process.env,
          TEAM_UP_HOME: home,
          TEAM_UP_ROSTER: rosterPath,
        },
        encoding: "utf8",
      },
    );
    assert.fail("expected non-zero exit");
  } catch (error) {
    assert.equal(error.status, 1);
    const combined = `${error.stdout || ""}${error.stderr || ""}`;
    assert.match(combined, new RegExp(`handoff file not found: ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(combined, /write HANDOFF\.md in/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
