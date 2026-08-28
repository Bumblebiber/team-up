import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeSpecialistSegment, assertPathInsideRoot } from "../../src/specialists/safe-id.mjs";
import { installPackage } from "../../src/specialists/store.mjs";
import { validateManifest } from "../../src/specialists/manifest.mjs";

test("rejects path traversal id/version segments", () => {
  for (const bad of ["../../escape", "../x", "a/b", "a\\b", "/abs", "", ".", "..", "a\0b", "a/../b"]) {
    assert.throws(() => assertSafeSpecialistSegment(bad, "id"), /invalid|unsafe|empty/i);
  }
  assert.doesNotThrow(() => assertSafeSpecialistSegment("testing.tessa", "id"));
  assert.doesNotThrow(() => assertSafeSpecialistSegment("0.1.0", "version"));
});

test("assertPathInsideRoot blocks escape", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-root-"));
  const inside = path.join(root, "ok");
  fs.mkdirSync(inside);
  assert.equal(assertPathInsideRoot(inside, root), path.resolve(inside));
  assert.throws(() => assertPathInsideRoot(path.join(root, "..", "escape"), root), /escapes|outside/i);
});

test("installPackage rejects malicious ../../escape id", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
  const manifest = {
    schema_version: 1,
    id: "../../escape",
    display_name: "Evil",
    version: "0.1.0",
    remit: ["x"],
    anti_remit: ["y"],
    call_types: ["consult"],
    accepted_inputs: ["task_description"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
    permissions: { filesystem: "project_readonly", writes: false, network: false, commands: [] },
    budget: { timeout_seconds: 60, max_tokens: 1000 },
    model_profile: { tier: "medium", reasoning: "low" },
    eval_suite: "evals/evals.json",
  };
  // Bypass validateManifest id check by writing raw then calling install which must reject
  fs.writeFileSync(path.join(pkg, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(pkg, "instructions.md"), "x\n");
  fs.mkdirSync(path.join(pkg, "evals"));
  fs.writeFileSync(path.join(pkg, "evals", "evals.json"), "[]");
  assert.equal(validateManifest(manifest).ok, false);
  const env = { ...process.env, TEAM_UP_HOME: home };
  const result = await installPackage(pkg, env);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /id|unsafe|invalid|escape/i);
  const specialists = path.join(home, "specialists");
  if (fs.existsSync(specialists)) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        assert.ok(p.startsWith(specialists + path.sep) || p === specialists, p);
        if (e.isDirectory()) walk(p);
      }
    };
    walk(specialists);
  }
});
