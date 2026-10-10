import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BLOCK_END, BLOCK_START, OFF, cronEntries, editCrontab, setEntryEnabled, setEntryEnv, setEntrySchedule, withManagedBlock,
} from "../../src/dashboard/crontab.mjs";
import {
  RUNNER, buildAutomationView, deleteCustomJob, editBuiltin, lastRunFromLog, saveCustomJob, setCustomJobEnabled,
} from "../../src/dashboard/automation.mjs";
import { cronJobsPath, parseCronSections } from "../../src/dashboard/cron-jobs.mjs";

const LIVE = [
  "SHELL=/bin/bash",
  "# TIM WAL Watchdog — hourly",
  "0 * * * * /home/u/.hermes/scripts/tim-wal-watchdog.sh >> /x.log 2>&1",
  "23 */2 * * * STALE_RUNS_HOURS=12 /home/u/.hermes/scripts/stale-runs.sh >> /y.log 2>&1",
  "37 5 * * * /home/u/projects/team-up/scripts/insights-cron.sh >> /z.out 2>&1",
  "*/10 * * * * /usr/bin/flock -n /l /usr/bin/python3 /home/u/projects/team-up/scripts/usage-spender.py >> /s.log 2>&1",
  "",
].join("\n");

function fakeCron(initial) {
  const state = { text: initial, writes: 0 };
  const exec = (cmd, args, opts = {}) => {
    if (cmd === "crontab" && args[0] === "-l") {
      if (state.text === null) {
        const e = new Error("Command failed");
        e.stderr = "no crontab for u\n";
        throw e;
      }
      return state.text;
    }
    if (cmd === "crontab" && args[0] === "-") {
      state.text = opts.input;
      state.writes++;
      return "";
    }
    if (cmd === "systemctl") return "Id=team-up-gc.timer\nActiveState=active\nSubState=waiting\nUnitFileState=enabled\n";
    throw new Error(`unexpected command ${cmd}`);
  };
  return { state, exec };
}

const home = os.homedir();
const project = path.join(home, "projects", "demo");
fs.mkdirSync(project, { recursive: true });
const models = ["claude:claude-sonnet", "codex:gpt-6-luna"];

test("switching a line off and on again restores it byte for byte", () => {
  const off = setEntryEnabled(LIVE, "insights-cron.sh", false);
  assert.ok(off.includes(`${OFF}37 5 * * * /home/u/projects/team-up/scripts/insights-cron.sh`));
  assert.equal(cronEntries(off).find((e) => e.command.includes("insights")).enabled, false);
  assert.equal(setEntryEnabled(off, "insights-cron.sh", true), LIVE);
  assert.throws(() => setEntryEnabled(LIVE, "nope.sh", false), /no crontab line runs/);
});

test("schedule and env knob edits touch only their own line, and only those fields", () => {
  const moved = setEntrySchedule(LIVE, "stale-runs.sh", "41 */3 * * *");
  assert.ok(moved.includes("41 */3 * * * STALE_RUNS_HOURS=12 /home/u/.hermes/scripts/stale-runs.sh >> /y.log 2>&1"));
  assert.equal(moved.split("\n").filter((l, i) => l !== LIVE.split("\n")[i]).length, 1);
  assert.throws(() => setEntrySchedule(LIVE, "stale-runs.sh", "* * * * * rm -rf ~"), /exactly 5 fields/);
  assert.throws(() => setEntrySchedule(LIVE, "stale-runs.sh", "* * * * *\n* * * * * evil"), /one line/);
  const knob = setEntryEnv(LIVE, "stale-runs.sh", "STALE_RUNS_HOURS", "24");
  assert.ok(knob.includes("23 */2 * * * STALE_RUNS_HOURS=24 /home/u/.hermes/scripts/stale-runs.sh"));
  const gone = setEntryEnv(LIVE, "stale-runs.sh", "STALE_RUNS_HOURS", null);
  assert.ok(gone.includes("23 */2 * * * /home/u/.hermes/scripts/stale-runs.sh"));
  assert.throws(() => setEntryEnv(LIVE, "stale-runs.sh", "STALE_RUNS_HOURS", "1; rm"), /bad value/);
});

test("the managed block is added, replaced and removed without touching other lines", () => {
  const added = withManagedBlock(LIVE, ["0 6 * * 1 /r/cron-job.sh weekly"]);
  assert.ok(added.startsWith(LIVE));
  assert.ok(added.endsWith(`${BLOCK_START}\n0 6 * * 1 /r/cron-job.sh weekly\n${BLOCK_END}\n`));
  const replaced = withManagedBlock(added, ["5 6 * * 1 /r/cron-job.sh weekly", "0 0 * * * /r/cron-job.sh nightly"]);
  assert.equal(replaced.split(BLOCK_START)[0], added.split(BLOCK_START)[0]);
  assert.equal(withManagedBlock(replaced, []), LIVE);
  assert.throws(() => withManagedBlock(`${LIVE}${BLOCK_START}\n`, []), /block is broken/);
});

test("editCrontab backs up before writing and leaves an unchanged crontab alone", () => {
  const { state, exec } = fakeCron(LIVE);
  assert.deepEqual(editCrontab((t) => t, { exec }), { changed: false, backup: null });
  assert.equal(state.writes, 0);
  const { backup } = editCrontab((t) => setEntryEnabled(t, "usage-spender.py", false), { exec });
  assert.equal(fs.readFileSync(backup, "utf8"), LIVE);
  assert.equal(state.writes, 1);
  const none = fakeCron(null);
  editCrontab((t) => withManagedBlock(t, ["@daily /r/cron-job.sh x"]), { exec: none.exec });
  assert.equal(none.state.text, `${BLOCK_START}\n@daily /r/cron-job.sh x\n${BLOCK_END}\n`);
});

test("built-in jobs: found by script, explained, switchable; Hermes jobs are read-only", () => {
  const { state, exec } = fakeCron(LIVE);
  const view = buildAutomationView({ exec, now: new Date(2026, 9, 10, 13, 0) });
  const insights = view.builtin.find((j) => j.id === "insights");
  assert.equal(insights.installed, true);
  assert.equal(insights.when.text, "daily at 05:37");
  assert.ok(insights.what && insights.cost);
  const stale = view.builtin.find((j) => j.id === "stale-runs");
  assert.equal(stale.knobs[0].value, "12");
  assert.equal(view.builtin.find((j) => j.id === "harness-health").installed, false);
  assert.equal(view.crontab.otherLines, 1, "the TIM watchdog is someone else's");

  editBuiltin({ id: "insights", enabled: false }, { exec });
  assert.equal(buildAutomationView({ exec }).builtin.find((j) => j.id === "insights").enabled, false);
  editBuiltin({ id: "stale-runs", knob: { key: "STALE_RUNS_HOURS", value: 24 } }, { exec });
  assert.ok(state.text.includes("STALE_RUNS_HOURS=24"));
  editBuiltin({ id: "insights", knob: { key: "INSIGHTS_NO_MERGE", value: true } }, { exec });
  assert.ok(state.text.includes("INSIGHTS_NO_MERGE=1 /home/u/projects/team-up/scripts/insights-cron.sh"));
  assert.throws(() => editBuiltin({ id: "stale-runs", knob: { key: "STALE_RUNS_HOURS", value: 0 } }, { exec }), /whole number/);
  assert.throws(() => editBuiltin({ id: "stale-runs", knob: { key: "PATH", value: 1 } }, { exec }), /no setting PATH/);
  assert.throws(() => editBuiltin({ id: "golden-task", enabled: false }, { exec }), /Hermes/);
});

test("custom job: saved to the ini and its prompt file, installed as one managed line", () => {
  const { state, exec } = fakeCron(LIVE);
  saveCustomJob({
    name: "weekly-audit", description: "Audit\nthe repo", schedule: "0 6 * * 1", model: "codex:gpt-6-luna",
    cwd: project, prompt: "Audit this repo.", notify: true,
  }, { exec, modelOptions: models });
  const section = parseCronSections(fs.readFileSync(cronJobsPath(), "utf8")).find((s) => s.name === "weekly-audit");
  assert.deepEqual(section.values, {
    custom: "true", description: "Audit the repo", schedule: "0 6 * * 1", model: "codex:gpt-6-luna",
    cwd: fs.realpathSync(project), notify: "true", enabled: "true",
  });
  assert.ok(state.text.startsWith(LIVE), "nothing outside the block moved");
  assert.ok(state.text.includes(`${BLOCK_START}\n0 6 * * 1 ${RUNNER} weekly-audit\n${BLOCK_END}`));

  const view = buildAutomationView({ exec, modelOptions: models });
  const job = view.custom.find((j) => j.name === "weekly-audit");
  assert.equal(job.inSync, true);
  assert.equal(job.prompt.trim(), "Audit this repo.");
  assert.equal(job.when.text, "every Monday at 06:00");

  setCustomJobEnabled("weekly-audit", false, { exec });
  assert.ok(!state.text.includes("weekly-audit"), "a switched-off job leaves cron, stays in the ini");
  assert.equal(buildAutomationView({ exec }).custom.find((j) => j.name === "weekly-audit").enabled, false);

  saveCustomJob({
    original: "weekly-audit", name: "monday-audit", schedule: "@daily", model: "claude:claude-sonnet",
    cwd: project, prompt: "Audit.", enabled: true,
  }, { exec, modelOptions: models });
  assert.ok(state.text.includes(`@daily ${RUNNER} monday-audit`));
  assert.ok(!fs.readFileSync(cronJobsPath(), "utf8").includes("[weekly-audit]"), "renamed, not copied");

  deleteCustomJob("monday-audit", { exec });
  assert.equal(state.text, LIVE);
});

test("custom job input is checked before anything is written", () => {
  const { state, exec } = fakeCron(LIVE);
  const ok = { name: "j", schedule: "@daily", model: "claude:claude-sonnet", cwd: project, prompt: "p" };
  const refuse = (patch, re) => assert.throws(() => saveCustomJob({ ...ok, ...patch }, { exec, modelOptions: models }), re);
  refuse({ name: "Bad Name" }, /name:/);
  refuse({ name: "../x" }, /name:/);
  refuse({ name: "insights" }, /built-in/);
  refuse({ schedule: "* * * * * curl evil" }, /exactly 5 fields/);
  refuse({ schedule: "@daily\n* * * * * evil" }, /one line/);
  refuse({ model: "sh:-c" }, /model:/);
  refuse({ cwd: "/etc" }, /inside your home/);
  refuse({ cwd: "~/does-not-exist" }, /no such folder/);
  refuse({ prompt: "  " }, /prompt is required/);
  assert.equal(state.writes, 0);
});

test("last run is read from the runner's start/end markers", () => {
  assert.equal(lastRunFromLog(""), null);
  assert.deepEqual(lastRunFromLog("=== start 2026-10-10T06:00:00+02:00\nok\n=== end 2026-10-10T06:20:00+02:00 exit 0\n"),
    { at: "2026-10-10T06:20:00+02:00", exit: 0, running: false });
  assert.deepEqual(lastRunFromLog("=== end a exit 1\n=== start b\n"), { at: "b", exit: null, running: true });
});
