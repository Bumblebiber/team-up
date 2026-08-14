import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRecommendations } from "../../src/capabilities/recommendations.mjs";

test("recommendations normalize as inert display metadata", () => {
  assert.deepEqual(
    normalizeRecommendations([
      {
        package: "o9k.caveman",
        source: "https://github.com/example/caveman.git",
        reason: "Reduces routine output",
        suggested_target: "research.rick",
      },
    ]),
    [
      {
        package: "o9k.caveman",
        source: "https://github.com/example/caveman.git",
        reason: "Reduces routine output",
        suggested_target: "research.rick",
        selected: false,
      },
    ]
  );
});

test("nothing is ever preselected", () => {
  const [row] = normalizeRecommendations([
    {
      package: "x",
      source: "https://example.invalid/x.git",
      reason: "y",
      selected: true,
    },
  ]);
  assert.equal(row.selected, false);
});

test("recommendations reject embedded credentials and concrete models", () => {
  assert.throws(
    () =>
      normalizeRecommendations([
        {
          package: "x",
          source: "https://user:secret@example.invalid/x",
          reason: "x",
          model: "fixed",
        },
      ]),
    /credentials|forbidden/
  );
  assert.throws(
    () =>
      normalizeRecommendations([
        {
          package: "x",
          source: "https://user:secret@example.invalid/x",
          reason: "x",
        },
      ]),
    /credentials/
  );
});

test("recommendations require package, source and reason", () => {
  for (const partial of [
    { source: "https://example.invalid/x", reason: "r" },
    { package: "x", reason: "r" },
    { package: "x", source: "https://example.invalid/x" },
  ]) {
    assert.throws(() => normalizeRecommendations([partial]), /requires/);
  }
  assert.throws(() => normalizeRecommendations("nope"), /array/);
});

test("a suggested target must be a safe specialist id", () => {
  assert.throws(
    () =>
      normalizeRecommendations([
        {
          package: "x",
          source: "https://example.invalid/x",
          reason: "r",
          suggested_target: "all/../../x",
        },
      ]),
    /suggested_target/
  );
});
