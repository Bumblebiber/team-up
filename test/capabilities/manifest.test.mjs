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

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-cap-"));
  return fs.realpathSync(root);
}

test("normalizes all provider arrays and validates declared files", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "skills", "caveman"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "caveman", "SKILL.md"), "# Caveman\n");
  const manifest = normalizeCapabilityManifest(
    {
      schema_version: 1,
      id: "o9k.caveman",
      version: "1.2.0",
      display_name: "Caveman",
      provides: { skills: ["skills/caveman/SKILL.md"] },
      permissions: { network: false, commands: [] },
    },
    { packageDir: root }
  );
  assert.deepEqual(manifest.provides, {
    skills: ["skills/caveman/SKILL.md"],
    plugins: [],
    mcps: [],
    frameworks: [],
  });
  assert.deepEqual(manifest.permissions, {
    network: false,
    commands: [],
    filesystem: "none",
  });
  assert.deepEqual(declaredCapabilityFiles(root, manifest), [
    "skills/caveman/SKILL.md",
  ]);
});

test("expands declared directories deterministically", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "framework", "b"), { recursive: true });
  fs.writeFileSync(path.join(root, "framework", "b", "two.md"), "two\n");
  fs.writeFileSync(path.join(root, "framework", "one.md"), "one\n");
  const manifest = normalizeCapabilityManifest({
    schema_version: 1,
    id: "acme.framework",
    version: "0.1.0",
    display_name: "Framework",
    provides: { frameworks: ["framework"] },
  });
  assert.deepEqual(declaredCapabilityFiles(root, manifest), [
    "framework/b/two.md",
    "framework/one.md",
  ]);
});

test("rejects escapes, symlinks, concrete models, and lifecycle hooks", () => {
  assert.throws(
    () =>
      normalizeCapabilityManifest({
        schema_version: 1,
        id: "bad",
        version: "1",
        display_name: "Bad",
        model: "fixed-model",
        provides: { skills: ["../secret"] },
        permissions: { network: false, commands: [] },
        scripts: { install: "curl example" },
      }),
    /forbidden key|safe relative path|unsafe/
  );

  assert.throws(
    () =>
      normalizeCapabilityManifest({
        schema_version: 1,
        id: "bad",
        version: "1",
        display_name: "Bad",
        provides: { skills: ["../secret"] },
      }),
    /unsafe|parent segment/
  );

  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "skills"), { recursive: true });
  fs.symlinkSync("/etc/passwd", path.join(root, "skills", "leak.md"));
  const manifest = normalizeCapabilityManifest({
    schema_version: 1,
    id: "acme.leak",
    version: "0.1.0",
    display_name: "Leak",
    provides: { skills: ["skills/leak.md"] },
  });
  assert.throws(() => declaredCapabilityFiles(root, manifest), /symlink/);
});

test("rejects unsupported schema versions and missing declared files", () => {
  assert.throws(
    () =>
      normalizeCapabilityManifest({
        schema_version: 2,
        id: "acme.x",
        version: "1",
        display_name: "X",
      }),
    /schema_version/
  );

  const root = tmpRoot();
  assert.throws(
    () =>
      normalizeCapabilityManifest(
        {
          schema_version: 1,
          id: "acme.x",
          version: "1",
          display_name: "X",
          provides: { skills: ["skills/missing.md"] },
        },
        { packageDir: root }
      ),
    /missing/
  );
});

test("rejects invalid permission shapes", () => {
  assert.throws(
    () =>
      normalizeCapabilityManifest({
        schema_version: 1,
        id: "acme.x",
        version: "1",
        display_name: "X",
        permissions: { network: "yes", commands: [] },
      }),
    /permissions/
  );
  assert.throws(
    () =>
      normalizeCapabilityManifest({
        schema_version: 1,
        id: "acme.x",
        version: "1",
        display_name: "X",
        permissions: { network: false, commands: [], filesystem: "root" },
      }),
    /permissions/
  );
});

test("capability state paths honor TEAM_UP_HOME", () => {
  const env = { TEAM_UP_HOME: "/tmp/team-up-test" };
  assert.equal(capabilityPoolRoot(env), "/tmp/team-up-test/capability-pool");
  assert.equal(
    capabilityAssignmentsPath(env),
    "/tmp/team-up-test/capability-assignments.json"
  );
});
