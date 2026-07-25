import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBudget } from "../../src/specialists/budget.mjs";

test("schema-v2 advisory token target", () => {
  assert.deepEqual(
    normalizeBudget({
      timeout_seconds: 1800,
      tokens: { target: 80000, enforcement: "advisory" },
    }),
    {
      timeout_seconds: 1800,
      tokens: { target: 80000, enforcement: "advisory" },
      warnings: [],
    }
  );
});

test("schema-v1 max_tokens migrates without hard enforcement", () => {
  const result = normalizeBudget({ timeout_seconds: 1800, max_tokens: 80000 });
  assert.equal(result.tokens.target, 80000);
  assert.equal(result.tokens.enforcement, "advisory");
  assert.match(result.warnings[0], /max_tokens.*advisory/);
});

test("hard enforcement is rejected until an adapter exists", () => {
  assert.throws(
    () => normalizeBudget({ tokens: { target: 80000, enforcement: "hard" } }),
    /unsupported token enforcement/
  );
});
