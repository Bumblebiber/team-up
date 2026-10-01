import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendSample, listDayFiles, pruneTelemetry, readSamples } from "../../src/telemetry/store.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tu-tel-"));
}

test("appendSample writes one line per sample into the UTC day file", () => {
  const dir = path.join(tmp(), "telemetry");
  try {
    appendSample({ at: "2026-10-01T23:59:50.000Z", n: 1 }, { dir });
    appendSample({ at: "2026-10-02T00:00:20.000Z", n: 2 }, { dir });
    appendSample({ at: "2026-10-02T00:00:50.000Z", n: 3 }, { dir });
    assert.deepEqual(listDayFiles(dir).map((f) => path.basename(f)), ["2026-10-01.jsonl", "2026-10-02.jsonl"]);
    assert.equal(fs.readFileSync(path.join(dir, "2026-10-02.jsonl"), "utf8").trim().split("\n").length, 2);
    assert.equal(fs.statSync(path.join(dir, "2026-10-02.jsonl")).mode & 0o777, 0o600);
    assert.deepEqual(readSamples({ dir }).map((s) => s.n), [1, 2, 3]);
    assert.deepEqual(readSamples({ dir, since: "2026-10-02T00:00:00Z" }).map((s) => s.n), [2, 3]);
    assert.deepEqual(readSamples({ dir, until: "2026-10-02T00:00:30Z" }).map((s) => s.n), [1, 2]);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("a line cut off by a crash is skipped, not fatal", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "2026-10-01.jsonl"),
      `${JSON.stringify({ at: "2026-10-01T10:00:00Z", n: 1 })}\n{"at":"2026-10-01T10:00:30Z","n":\n` +
      `${JSON.stringify({ at: "2026-10-01T10:01:00Z", n: 3 })}\n`);
    assert.deepEqual(readSamples({ dir }).map((s) => s.n), [1, 3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retention deletes whole days past the limit and nothing else", () => {
  const dir = tmp();
  try {
    for (const name of ["2026-09-20.jsonl", "2026-09-23.jsonl", "2026-09-24.jsonl", "2026-10-01.jsonl", "notes.txt"]) {
      fs.writeFileSync(path.join(dir, name), "");
    }
    const removed = pruneTelemetry({ dir, now: new Date("2026-10-01T12:00:00Z"), retentionDays: 7 });
    assert.deepEqual(removed.map((f) => path.basename(f)), ["2026-09-20.jsonl", "2026-09-23.jsonl"]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["2026-09-24.jsonl", "2026-10-01.jsonl", "notes.txt"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
