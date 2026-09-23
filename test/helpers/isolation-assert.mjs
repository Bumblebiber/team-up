import assert from "node:assert/strict";
import { isIsoFailure } from "../../src/harness/isolation-result.mjs";

export function assertIsoFailure(result, expectedReason = null) {
  assert.ok(isIsoFailure(result), `expected isolation failure, got ${JSON.stringify(result)}`);
  if (expectedReason != null) {
    assert.equal(result.reason, expectedReason);
  }
}
