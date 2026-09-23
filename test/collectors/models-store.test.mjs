import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeModelsStore, formatStoreAge } from "../../src/collectors/models-store.mjs";
import { runModelsList } from "../../src/commands/models-list.mjs";
import { atomicWriteText } from "../../src/json-store.mjs";

test("mergeModelsStore keeps prior CLI entry with stale_since when scan fails", () => {
  const scannedAt = "2026-09-23T12:00:00.000Z";
  const previous = {
    scanned_at: "2026-09-22T12:00:00.000Z",
    clis: {
      cursor: {
        supported: true,
        scanned_at: "2026-09-22T12:00:00.000Z",
        models: [{ cli_id: "auto", display_name: "Auto" }],
        gone: [],
        new_count: 0,
      },
    },
  };
  const reports = [{ cli: "cursor", supported: false, reason: "boom" }];
  const collected = new Map([["cursor", { supported: false, reason: "boom" }]]);
  const merged = mergeModelsStore(previous, reports, collected, scannedAt);
  assert.equal(merged.clis.cursor.models[0].cli_id, "auto");
  assert.equal(merged.clis.cursor.stale_since, scannedAt);
  assert.match(merged.clis.cursor.reason, /boom/);
});

test("mergeModelsStore writes successful scan with models and new_count", () => {
  const scannedAt = "2026-09-23T12:00:00.000Z";
  const reports = [
    {
      cli: "cursor",
      supported: true,
      known: [],
      new: [{ cli_id: "auto" }],
      gone: [{ roster_id: "gone", sent: "old" }],
    },
  ];
  const collected = new Map([
    ["cursor", { supported: true, models: [{ id: "auto", display_name: "Auto" }] }],
  ]);
  const merged = mergeModelsStore(null, reports, collected, scannedAt);
  assert.equal(merged.clis.cursor.new_count, 1);
  assert.deepEqual(merged.clis.cursor.gone, [{ roster_id: "gone", sent: "old" }]);
  assert.equal(merged.clis.cursor.models[0].cli_id, "auto");
});

test("runModelsList reads temp TEAM_UP_HOME including empty case", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-models-"));
  const env = { ...process.env, TEAM_UP_HOME: dir };
  const out = [];
  const err = [];
  assert.equal(runModelsList([], { out: (s) => out.push(s), err: (s) => err.push(s) }, { env }), 0);
  assert.match(out.join("\n"), /empty/);

  atomicWriteText(
    path.join(dir, "models.json"),
    JSON.stringify(
      {
        scanned_at: "2026-09-23T10:00:00.000Z",
        clis: { cursor: { supported: true, models: [{ cli_id: "auto", display_name: "Auto" }], gone: [], new_count: 0 } },
      },
      null,
      2
    )
  );
  out.length = 0;
  assert.equal(runModelsList(["--cli", "cursor"], { out: (s) => out.push(s), err: (s) => err.push(s) }, { env }), 0);
  assert.match(out.join("\n"), /auto/);
});

test("formatStoreAge renders human units", () => {
  assert.equal(formatStoreAge(30_000), "30s ago");
  assert.equal(formatStoreAge(120_000), "2m ago");
});
