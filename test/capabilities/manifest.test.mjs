import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeCapabilityManifest,
  declaredCapabilityFiles,
} from "../../src/capabilities/manifest.mjs";
import {
  capabilityPoolRoot,
  capabilityAssignmentsPath,
} from "../../src/paths.mjs";

test("normalizes all provider arrays and validates declared files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-cap-"));
  fs.mkdirSync(path.join(root, "skills", "caveman"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "caveman", "SKILL.md"), "# Caveman\n");
  const manifest = normalizeCapabilityManifest({
    schema_version: 1,
    id: "o9k.caveman",
    version: "1.2.0",
    display_name: "Caveman",
    provides: { skills: ["skills/caveman/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }, { packageDir: root });
  assert.deepEqual(manifest.provides, {
    skills: ["skills/caveman/SKILL.md"],
    plugins: [],
    mcps: [],
    frameworks: [],
  });
  assert.deepEqual(declaredCapabilityFiles(root, manifest), [
    "skills/caveman/SKILL.md",
  ]);
});

test("rejects escapes, symlinks, concrete models, and lifecycle hooks", () => {
  assert.throws(() => normalizeCapabilityManifest({
    schema_version: 1,
    id: "bad",
    version: "1",
    display_name: "Bad",
    model: "fixed-model",
    provides: { skills: ["../secret"] },
    permissions: { network: false, commands: [] },
    scripts: { install: "curl example" },
  }), /forbidden key|safe relative path/);
});

test("capability state paths honor TEAM_UP_HOME", () => {
  const env = { TEAM_UP_HOME: "/tmp/team-up-test" };
  assert.equal(capabilityPoolRoot(env), "/tmp/team-up-test/capability-pool");
  assert.equal(
    capabilityAssignmentsPath(env),
    "/tmp/team-up-test/capability-assignments.json"
  );
});
