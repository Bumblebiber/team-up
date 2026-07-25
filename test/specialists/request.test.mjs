import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRequest, validateResult } from "../../src/specialists/request.mjs";

test("review is read-only by default", () => {
  const request = normalizeRequest({
    specialist_id: "testing.hannes",
    call_type: "review",
    objective: "Review test plan",
    inputs: []
  });
  assert.equal(request.permissions.writes, false);
  assert.equal(request.depth, 0);
});

test("result rejects unknown status", () => {
  assert.throws(() => validateResult({ status: "done-ish" }), /status/);
});
