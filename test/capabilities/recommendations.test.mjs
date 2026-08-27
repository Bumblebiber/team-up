import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRecommendations }
  from "../../src/capabilities/recommendations.mjs";

test("recommendations normalize as inert display metadata", () => {
  assert.deepEqual(normalizeRecommendations([{
    package: "o9k.caveman",
    source: "https://github.com/example/caveman.git",
    reason: "Reduces routine output",
    suggested_target: "research.reanna",
  }]), [{
    package: "o9k.caveman",
    source: "https://github.com/example/caveman.git",
    reason: "Reduces routine output",
    suggested_target: "research.reanna",
    selected: false,
  }]);
});

test("recommendations reject embedded credentials and concrete models", () => {
  assert.throws(() => normalizeRecommendations([{
    package: "x", source: "https://user:secret@example.invalid/x",
    reason: "x", model: "fixed",
  }]), /credentials|forbidden/);
});
