import test from "node:test";
import assert from "node:assert/strict";
import {
  materializePartialCheckpoint,
  validateCheckpoint,
} from "../../src/supervisor/checkpoint.mjs";

test("checkpoint schema rejects unknown fields and id mismatch", () => {
  const base = materializePartialCheckpoint({
    runId: "r1",
    attemptId: "a0001",
  });
  assert.equal(validateCheckpoint(base, { runId: "r1", attemptId: "a0001" }).ok, true);
  assert.equal(validateCheckpoint({ ...base, extra: true }).ok, false);
  assert.equal(validateCheckpoint(base, { runId: "other", attemptId: "a0001" }).ok, false);
});

test("partial controller checkpoint is accepted", () => {
  const cp = materializePartialCheckpoint({ runId: "r1", attemptId: "a0001" });
  assert.equal(cp.status, "partial");
  assert.equal(validateCheckpoint(cp).ok, true);
});
