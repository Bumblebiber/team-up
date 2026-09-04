import { test } from "node:test";
import assert from "node:assert/strict";
import { mapId, normalizeBenchmarks } from "../../src/collectors/openrouter-benchmarks.mjs";

const ID_MAP = { "x-ai/grok-4.5": "grok-4.5-high" };

test("mapId collapses a dated permaslug onto the catalogue id", () => {
  // Exact hit still wins.
  assert.equal(mapId("x-ai/grok-4.5", ID_MAP), "grok-4.5-high");
  // Dated benchmark row reaches the same roster model.
  assert.equal(mapId("x-ai/grok-4.5-20260708", ID_MAP), "grok-4.5-high");
  // Unmapped model lands on the key the catalogue produces, so the two merge.
  assert.equal(mapId("x-ai/grok-4.6-20260810", ID_MAP), "x-ai--grok-4.6");
  // A trailing number that is not a date is left alone.
  assert.equal(mapId("openai/gpt-4o-2024", ID_MAP), "openai--gpt-4o-2024");
});

test("normalizeBenchmarks keeps the newer of two dated snapshots", () => {
  const payload = {
    data: [
      { model_permaslug: "deepseek/deepseek-v4-pro-20260813", coding_index: 72 },
      { model_permaslug: "deepseek/deepseek-v4-pro-20260423", coding_index: 51 },
    ],
  };
  const out = normalizeBenchmarks(payload, {});
  assert.equal(out.models["deepseek--deepseek-v4-pro"].scores.coding_index, 72);
  // Order in the feed must not decide it.
  const reversed = normalizeBenchmarks({ data: [...payload.data].reverse() }, {});
  assert.equal(reversed.models["deepseek--deepseek-v4-pro"].scores.coding_index, 72);
});
