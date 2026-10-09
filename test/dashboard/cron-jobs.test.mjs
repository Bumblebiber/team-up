import { test } from "node:test";
import assert from "node:assert/strict";
import { cronModelOptions, parseCronJobs, setCronJobModel } from "../../src/dashboard/cron-jobs.mjs";

test("parseCronJobs returns sections in file order and null for missing model", () => {
  const text = "# jobs\n[golden-task]\nmodel = claude:sonnet\n; note\n\n[insights]\n# no model yet\n";
  assert.deepEqual(parseCronJobs(text), [
    { name: "golden-task", model: "claude:sonnet" },
    { name: "insights", model: null },
  ]);
});

test("setCronJobModel changes only model value and preserves other bytes", () => {
  const text = "# keep\r\n[golden-task]\r\n; before\r\nmodel = old-model  \r\n# after\r\n\r\n[insights]\r\nmodel = claude:opus\r\n";
  const expected = text.replace("model = old-model", "model = cursor:new-model");
  assert.equal(setCronJobModel(text, "golden-task", "cursor:new-model"), expected);
});

test("setCronJobModel inserts a missing model directly after section header", () => {
  const text = "# keep\n[golden-task]\n; still here\n\n[insights]\nmodel = claude:opus\n";
  const expected = "# keep\n[golden-task]\nmodel = codex:gpt\n; still here\n\n[insights]\nmodel = claude:opus\n";
  assert.equal(setCronJobModel(text, "golden-task", "codex:gpt"), expected);
});

test("setCronJobModel rejects unknown section", () => {
  assert.throws(() => setCronJobModel("[known]\n", "missing", "claude:sonnet"), {
    message: "unknown cron job: missing",
  });
});

test("cronModelOptions offers sorted unique model and CLI pairs with templates", () => {
  const roster = {
    clis: { cursor: { cmd: ["cursor"] }, claude: { cmd: ["claude"] }, empty: null, noTemplate: {} },
    models: {
      zed: { cli: ["cursor", "missing", "cursor", "noTemplate"] },
      alpha: { cli: ["claude", "empty"] },
      ignored: { cli: "claude" },
    },
  };
  assert.deepEqual(cronModelOptions(roster), ["claude:alpha", "cursor:zed"]);
});
