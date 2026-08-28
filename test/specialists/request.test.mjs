import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRequest, validateResult, MAX_DEPTH } from "../../src/specialists/request.mjs";

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

test("depth is bounded at MAX_DEPTH", () => {
  const base = {
    specialist_id: "testing.hannes",
    call_type: "delegate",
    objective: "run the suite",
  };
  assert.equal(normalizeRequest(base).depth, 0);
  assert.equal(normalizeRequest({ ...base, depth: MAX_DEPTH }).depth, MAX_DEPTH);
  assert.throws(
    () => normalizeRequest({ ...base, depth: MAX_DEPTH + 1 }),
    /exceeds maximum nesting/
  );
  assert.throws(() => normalizeRequest({ ...base, depth: -1 }), /invalid depth/);
  assert.throws(() => normalizeRequest({ ...base, depth: 1.5 }), /invalid depth/);
});
