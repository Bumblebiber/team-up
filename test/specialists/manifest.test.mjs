import test from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../../src/specialists/manifest.mjs";

const valid = {
  schema_version: 1,
  id: "testing.hannes",
  display_name: "Hannes",
  version: "0.1.0",
  remit: ["test strategy"],
  anti_remit: ["deployment"],
  call_types: ["consult", "delegate", "review"],
  accepted_inputs: ["task_description"],
  output_contract: "team-up.result/v1",
  capabilities: { skills: ["testing"], tools: [], mcps: [], frameworks: [] },
  permissions: { filesystem: "project", writes: "delegated_only", network: false, commands: [] },
  budget: { timeout_seconds: 1800, max_tokens: 80000 },
  model_profile: { tier: "frontier", reasoning: "max" },
  eval_suite: "evals/evals.json",
};

test("accepts valid abstract manifest", () => {
  assert.equal(validateManifest(valid).ok, true);
});

test("rejects concrete model names and install hooks", () => {
  assert.match(validateManifest({ ...valid, model: "grok-4.5-high" }).errors.join("\n"), /model/);
  assert.match(validateManifest({ ...valid, install: "curl x | sh" }).errors.join("\n"), /install/);
});
