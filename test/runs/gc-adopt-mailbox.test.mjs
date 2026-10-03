import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

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
    plant(home, "20260101T000000Z-wait", { status: "waiting_human", mailboxStatus: "done" });
    await gc.gcRuns({ now: new Date(), listSessions: () => [] });
    assert.equal(statusOf(home, "20260101T000000Z-wait"), "done");
  });
});

test("a run that finished mid-handoff adopts it too", async () => {
  await withHome(async ({ home, gc }) => {
    plant(home, "20260101T000000Z-hand", { status: "handing_off", mailboxStatus: "done" });
    await gc.gcRuns({ now: new Date(), listSessions: () => [] });
    assert.equal(statusOf(home, "20260101T000000Z-hand"), "done");
  });
});

test("a run still genuinely waiting is left alone", async () => {
  await withHome(async ({ home, gc }) => {
    // The mailbox agrees it is waiting. Nothing here may touch it — that is the
    // case the protected statuses exist for.
    plant(home, "20260101T000000Z-askn", {
      status: "waiting_human",
      mailboxStatus: "waiting_human",
      result: null,
    });
    await gc.gcRuns({ now: new Date(), listSessions: () => [] });
    assert.equal(statusOf(home, "20260101T000000Z-askn"), "waiting_human");
  });
});

test("a dry run changes nothing", async () => {
  await withHome(async ({ home, gc }) => {
    plant(home, "20260101T000000Z-dry0", { status: "waiting_human", mailboxStatus: "done" });
    await gc.gcRuns({ now: new Date(), listSessions: () => [], dryRun: true });
    assert.equal(statusOf(home, "20260101T000000Z-dry0"), "waiting_human");
  });
});

test("adoption is reported so the change is visible in the log", async () => {
  await withHome(async ({ home, gc }) => {
    plant(home, "20260101T000000Z-seen", { status: "waiting_human", mailboxStatus: "done" });
    const report = await gc.gcRuns({ now: new Date(), listSessions: () => [] });
    const entry = report.runs.find((r) => r.runId === "20260101T000000Z-seen");
    assert.equal(entry.adopted_from_mailbox, "done");
  });
});

// A watcher verifying this done decides it; gc adopting the unverified done
// first would make a failing verdict unable to land (terminal is final).
test("a done whose verification is running is left to its verifier", async () => {
  await withHome(async ({ home, gc }) => {
    const dir = plant(home, "20260101T000000Z-vrfy", { status: "watching", mailboxStatus: "done" });
    const state = JSON.parse(fs.readFileSync(path.join(dir, "STATE.json"), "utf8"));
    fs.writeFileSync(path.join(dir, "STATE.json"), JSON.stringify({ ...state, verify: { command: ["true"], runs: 1 } }));
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      fs.writeFileSync(path.join(dir, "mailbox", ".VERIFICATION.lock"), `${holder.pid}\n`);
      await gc.gcRuns({ now: new Date(), listSessions: () => [] });
      assert.equal(statusOf(home, "20260101T000000Z-vrfy"), "watching");
    } finally {
      holder.kill();
    }
  });
});
