import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  planCapabilityUpdate,
  rollbackCapability,
  removeCapability,
} from "../../src/capabilities/lifecycle.mjs";
import { importLocalCapability, listInstalledCapabilities } from "../../src/capabilities/store.mjs";
import { enableCapability, loadAssignments } from "../../src/capabilities/assignments.mjs";
import { atomicWriteJson, loadJson } from "../../src/json-store.mjs";
import { capabilityAssignmentsPath, capabilityPoolRoot } from "../../src/paths.mjs";

test("update installs beside old checksum and does not mutate assignment", () => {
  const plan = planCapabilityUpdate({
    current: { package: "x@1", checksum: "sha256:a" },
    candidate: { package: "x@2", checksum: "sha256:b" },
    assignments: [{ package: "x@1", checksum: "sha256:a",
      targets: ["all"], exclude: [] }],
  });
  assert.equal(plan.activate, false);
  assert.equal(plan.assignmentChanges.length, 0);
});

test("removal refuses assignment and active-run references", () => {
  const target = { package: "x@1", checksum: "sha256:a",
    packageDir: "/pool/x" };
  assert.throws(() => removeCapability(target, {
    assignments: [{ package: "x@1", checksum: "sha256:a",
      targets: ["all"], exclude: [] }],
    activeRuns: [],
  }), /CAPABILITY_REFERENCED.*assignment/);
  assert.throws(() => removeCapability(target, {
    assignments: [],
    activeRuns: [{ runId: "r1", capabilities: [{
      package: "x@1", checksum: "sha256:a",
    }] }],
  }), /CAPABILITY_REFERENCED.*r1/);
});

test("failed rollback leaves assignments byte-identical", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-life-"));
  const env = { TEAM_UP_HOME: home };
  enableCapability({
    package: "x@1", checksum: "sha256:a", target: "all", env,
  });
  const before = fs.readFileSync(capabilityAssignmentsPath(env));
  assert.throws(() => rollbackCapability({
    current: { package: "x@1", checksum: "sha256:a" },
    prior: null,
    assignments: loadAssignments({ env }).assignments,
    writeAssignments: (doc) => atomicWriteJson(capabilityAssignmentsPath(env), doc),
  }), /ROLLBACK_TARGET_NOT_INSTALLED/);
  assert.deepEqual(fs.readFileSync(capabilityAssignmentsPath(env)), before);
});

test("successful removal preserves sibling versions", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-life-"));
  const env = { TEAM_UP_HOME: home };
  function fixture(id, version, body) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-src-"));
    fs.mkdirSync(path.join(root, "skills", "s"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "s", "SKILL.md"), body);
    fs.writeFileSync(path.join(root, "capability.json"), JSON.stringify({
      schema_version: 1, id, version, display_name: id,
      provides: { skills: ["skills/s/SKILL.md"] },
      permissions: { network: false, commands: [] },
    }));
    return importLocalCapability(root, { env });
  }
  const first = fixture("sib", "1", "# one\n");
  const second = fixture("sib", "2", "# two\n");
  removeCapability(first, {
    assignments: [],
    activeRuns: [],
    removeFiles: (target) => {
      const digest = target.checksum.slice("sha256:".length);
      const dest = path.join(capabilityPoolRoot(env), target.id, target.version, digest);
      fs.rmSync(dest, { recursive: true, force: true });
      const indexPath = path.join(capabilityPoolRoot(env), "index.json");
      const index = loadJson(indexPath);
      index.packages = index.packages.filter((item) => item.checksum !== target.checksum);
      atomicWriteJson(indexPath, index);
    },
  });
  const remaining = listInstalledCapabilities({ env });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].checksum, second.checksum);
});
