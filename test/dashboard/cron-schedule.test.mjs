import test from "node:test";
import assert from "node:assert/strict";
import { describeSchedule, isValidSchedule, nextRun, parseSchedule } from "../../src/dashboard/cron-schedule.mjs";

test("only five plain cron fields or a named shortcut pass — nothing that could add a crontab line", () => {
  for (const ok of ["* * * * *", "*/10 * * * *", "37 5 * * *", "23 */2 * * *", "0 3 15 * *", "0 9 * * 1-5", "0 0,12 * * 0,7", "@daily"]) {
    assert.ok(isValidSchedule(ok), ok);
  }
  for (const bad of [
    "* * * * * rm -rf ~", "* * * *", "*/10 * * * *\n* * * * * evil", "60 * * * *", "0 24 * * *", "0 0 0 * *",
    "0 0 * 13 *", "0 0 * * 8", "*/0 * * * *", "5-1 * * * *", "@reboot", "$(x) * * * *", "a * * * *", "",
  ]) {
    assert.ok(!isValidSchedule(bad), JSON.stringify(bad));
  }
  assert.throws(() => parseSchedule("61 * * * *"), /minute: 61 is outside 0-59/);
});

test("common shapes read as plain words", () => {
  assert.equal(describeSchedule("* * * * *"), "every minute");
  assert.equal(describeSchedule("*/10 * * * *"), "every 10 minutes");
  assert.equal(describeSchedule("0 * * * *"), "every hour at :00");
  assert.equal(describeSchedule("23 */2 * * *"), "every 2 hours at :23");
  assert.equal(describeSchedule("37 5 * * *"), "daily at 05:37");
  assert.equal(describeSchedule("0 3 15 * *"), "monthly on the 15th at 03:00");
  assert.equal(describeSchedule("0 9 * * 1"), "every Monday at 09:00");
  assert.equal(describeSchedule("0 9 * * 1-5"), "weekdays at 09:00");
  assert.equal(describeSchedule("@daily"), "daily at 00:00");
  assert.equal(describeSchedule("5 4 1-7 * *"), 'cron "5 4 1-7 * *"');
});

test("next run follows cron semantics, including either-day matching", () => {
  const from = new Date(2026, 9, 10, 13, 34, 20); // Sat 10 Oct 2026 13:34:20 local
  assert.deepEqual(nextRun("*/10 * * * *", from), new Date(2026, 9, 10, 13, 40));
  assert.deepEqual(nextRun("37 5 * * *", from), new Date(2026, 9, 11, 5, 37));
  assert.deepEqual(nextRun("0 3 15 * *", from), new Date(2026, 9, 15, 3, 0));
  assert.deepEqual(nextRun("0 9 * * 1", from), new Date(2026, 9, 12, 9, 0));
  // dom 1 OR Monday: Monday the 12th comes first
  assert.deepEqual(nextRun("0 0 1 * 1", from), new Date(2026, 9, 12, 0, 0));
  assert.deepEqual(nextRun("0 0 * * 7", from), new Date(2026, 9, 11, 0, 0), "7 is Sunday");
  assert.equal(nextRun("0 0 31 2 *", from), null, "never fires");
});
