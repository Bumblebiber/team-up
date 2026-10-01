import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateManifest } from "../../src/specialists/manifest.mjs";

const valid = {
  schema_version: 1,
  id: "testing.tessa",
  display_name: "Tessa",
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

test("model_profile is optional and no longer checked — the roster assigns a role or chain", () => {
  const { model_profile, ...without } = valid;
  assert.equal(validateManifest(without).ok, true);
  assert.equal(validateManifest({ ...valid, model_profile: { tier: "huge", reasoning: "x" } }).ok, true);
});

test("rejects concrete model names and install hooks", () => {
  assert.match(validateManifest({ ...valid, model: "grok-4.5-high" }).errors.join("\n"), /model/);
  assert.match(validateManifest({ ...valid, install: "curl x | sh" }).errors.join("\n"), /install/);
});

test("recommendations pass without mutating assignment state", () => {
  const result = validateManifest({
    ...valid,
    recommendations: [{
      package: "style.caveman",
      source: "https://github.com/example/caveman.git",
      reason: "shorten output",
      suggested_target: "testing.tessa",
    }],
  });
  assert.equal(result.ok, true);
});

test("rejects unsafe recommendation suggested_target", () => {
  assert.match(validateManifest({
    ...valid,
    recommendations: [{
      package: "style.caveman",
      source: "https://github.com/example/caveman.git",
      reason: "x",
      suggested_target: "all/../../x",
    }],
  }).errors.join("\n"), /suggested_target|unsafe|path/);
});

test("a specialist cannot ship a skill marked main-only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-spec-scope-"));
  fs.mkdirSync(path.join(dir, "skills"));
  const manifest = { ...valid, capabilities: { ...valid.capabilities, skills: ["memory", "work"] } };
  fs.writeFileSync(path.join(dir, "skills", "memory.md"),
    "---\nname: memory\nmetadata:\n  team-up-scope: main\n---\n# m\n");
  fs.writeFileSync(path.join(dir, "skills", "work.md"),
    "---\nname: work\nmetadata:\n  team-up-scope: specialist\n---\n# w\n");
  const result = validateManifest(manifest, { packageDir: dir });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /skill memory is marked team-up-scope: main/);
  assert.doesNotMatch(result.errors.join("\n"), /skill work/);
});
