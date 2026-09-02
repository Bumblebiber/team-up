import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A worker that finishes writes its RESULT and sets its mailbox STATUS.
 * Carrying that into STATE.json only ever happened along gc's stale-failure
 * path, which a run reaches solely by being ACTIVE with a live terminal — so a
 * run that finished while in a protected state kept its old status forever,
 * with the answer sitting unread beside it.
 */
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-gcadopt-"));
  const prior = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  return import("../../src/runs/gc.mjs")
    .then((gc) => fn({ home, gc }))
    .finally(() => {
      if (prior === undefined) delete process.env.TEAM_UP_HOME;
      else process.env.TEAM_UP_HOME = prior;
      fs.rmSync(home, { recursive: true, force: true });
    });
}

function plant(home, runId, { status, mailboxStatus, result = "# Result\n\nstatus: success\n" }) {
  const dir = path.join(home, "runs", runId);
  fs.mkdirSync(path.join(dir, "mailbox"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "STATE.json"),
    JSON.stringify({ runId, status, cwd: "/tmp", role: "implementer" })
  );
  fs.writeFileSync(path.join(dir, "mailbox", "STATUS"), `${mailboxStatus}\n`);
  if (result !== null) fs.writeFileSync(path.join(dir, "mailbox", "RESULT.md"), result);
  return dir;
}

function statusOf(home, runId) {
  return JSON.parse(
    fs.readFileSync(path.join(home, "runs", runId, "STATE.json"), "utf8")
  ).status;
}

test("a run that finished while waiting for a human adopts its mailbox", async () => {
  await withHome(async ({ home, gc }) => {
    plant(home, "r-waited", { status: "waiting_human", mailboxStatus: "done" });
    await gc.gcRuns({ now: new Date() });
    assert.equal(statusOf(home, "r-waited"), "done");
  });
});

test("a run that finished mid-handoff adopts it too", async () => {
  await withHome(async ({ home, gc }) => {
    plant(home, "r-handoff", { status: "handing_off", mailboxStatus: "done" });
    await gc.gcRuns({ now: new Date() });
    assert.equal(statusOf(home, "r-handoff"), "done");
  });
});

test("a run still genuinely waiting is left alone", async () => {
  await withHome(async ({ home, gc }) => {
    // The mailbox agrees it is waiting. Nothing here may touch it — that is the
    // case the protected statuses exist for.
    plant(home, "r-asking", {
      status: "waiting_human",
      mailboxStatus: "waiting_human",
      result: null,
    });
    await gc.gcRuns({ now: new Date() });
    assert.equal(statusOf(home, "r-asking"), "waiting_human");
  });
});

test("a dry run changes nothing", async () => {
  await withHome(async ({ home, gc }) => {
    plant(home, "r-dry", { status: "waiting_human", mailboxStatus: "done" });
    await gc.gcRuns({ now: new Date(), dryRun: true });
    assert.equal(statusOf(home, "r-dry"), "waiting_human");
  });
});

test("adoption is reported so the change is visible in the log", async () => {
  await withHome(async ({ home, gc }) => {
    plant(home, "r-seen", { status: "waiting_human", mailboxStatus: "done" });
    const report = await gc.gcRuns({ now: new Date() });
    const entry = report.runs.find((r) => r.runId === "r-seen");
    assert.equal(entry.adopted_from_mailbox, "done");
  });
});
