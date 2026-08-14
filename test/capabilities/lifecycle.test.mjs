import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  planCapabilityUpdate,
  rollbackCapability,
  removeCapability,
  activeRunCapabilityReferences,
} from "../../src/capabilities/lifecycle.mjs";
import { importLocalCapability, listInstalledCapabilities } from "../../src/capabilities/store.mjs";
import { enableCapability, loadAssignments } from "../../src/capabilities/assignments.mjs";
import { capabilityAssignmentsPath } from "../../src/paths.mjs";

function tmpdir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function capabilitySource(body, version = "1.0.0") {
  const source = tmpdir("tu-cap-");
  fs.mkdirSync(path.join(source, "skills", "x"), { recursive: true });
  fs.writeFileSync(path.join(source, "skills", "x", "SKILL.md"), body);
  fs.writeFileSync(
    path.join(source, "capability.json"),
    JSON.stringify({
      schema_version: 1,
      id: "x",
      version,
      display_name: "X",
      provides: { skills: ["skills/x/SKILL.md"] },
      permissions: { network: false, commands: [] },
    })
  );
  return source;
}

test("update installs beside old checksum and does not mutate assignment", () => {
  const plan = planCapabilityUpdate({
    current: { package: "x@1", checksum: "sha256:a" },
    candidate: { package: "x@2", checksum: "sha256:b" },
    assignments: [
      { package: "x@1", checksum: "sha256:a", targets: ["all"], exclude: [] },
    ],
  });
  assert.equal(plan.activate, false);
  assert.equal(plan.assignmentChanges.length, 0);
  assert.equal(plan.pinnedAssignments.length, 1);
  assert.throws(
    () =>
      planCapabilityUpdate({
        current: { package: "x@1", checksum: "sha256:a" },
        candidate: { package: "x@1", checksum: "sha256:a" },
        assignments: [],
      }),
    /CAPABILITY_UPDATE_UNCHANGED/
  );
});

test("removal refuses assignment and active-run references", () => {
  const target = { package: "x@1", checksum: "sha256:a", packageDir: "/pool/x" };
  assert.throws(
    () =>
      removeCapability(target, {
        assignments: [
          { package: "x@1", checksum: "sha256:a", targets: ["all"], exclude: [] },
        ],
        activeRuns: [],
      }),
    /CAPABILITY_REFERENCED.*assignment/
  );
  assert.throws(
    () =>
      removeCapability(target, {
        assignments: [],
        activeRuns: [
          { runId: "r1", capabilities: [{ package: "x@1", checksum: "sha256:a" }] },
        ],
      }),
    /CAPABILITY_REFERENCED.*r1/
  );
});

test("an unreferenced version is removed without touching siblings", () => {
  const env = { TEAM_UP_HOME: tmpdir("tu-life-home-") };
  const keep = importLocalCapability(capabilitySource("# Keep\n"), { env });
  const drop = importLocalCapability(capabilitySource("# Drop\n"), { env });
  enableCapability({
    package: keep.package,
    checksum: keep.checksum,
    target: "all",
    env,
  });

  const removed = [];
  const result = removeCapability(drop, {
    assignments: loadAssignments({ env }).assignments,
    activeRuns: [],
    removeFiles: (target) => removed.push(target.checksum),
    env,
  });

  assert.equal(result.checksum, drop.checksum);
  assert.deepEqual(removed, [drop.checksum]);
  const remaining = listInstalledCapabilities({ env });
  assert.deepEqual(
    remaining.map((item) => item.checksum),
    [keep.checksum]
  );
  assert.equal(fs.existsSync(keep.packageDir), true);
});

test("a refused removal leaves the index and assignments byte-identical", () => {
  const env = { TEAM_UP_HOME: tmpdir("tu-life-home-") };
  const pinned = importLocalCapability(capabilitySource("# Pinned\n"), { env });
  enableCapability({
    package: pinned.package,
    checksum: pinned.checksum,
    target: "all",
    env,
  });

  const indexPath = path.join(env.TEAM_UP_HOME, "capability-pool", "index.json");
  const indexBefore = fs.readFileSync(indexPath, "utf8");
  const assignmentsBefore = fs.readFileSync(capabilityAssignmentsPath(env), "utf8");

  assert.throws(
    () =>
      removeCapability(pinned, {
        assignments: loadAssignments({ env }).assignments,
        activeRuns: [],
        env,
      }),
    /CAPABILITY_REFERENCED/
  );

  assert.equal(fs.readFileSync(indexPath, "utf8"), indexBefore);
  assert.equal(fs.readFileSync(capabilityAssignmentsPath(env), "utf8"), assignmentsBefore);
  assert.equal(fs.existsSync(pinned.packageDir), true);
});

test("rollback repoints only matching selectors", () => {
  const written = [];
  const result = rollbackCapability({
    current: { package: "x@2", checksum: "sha256:b" },
    prior: { package: "x@1", checksum: "sha256:a" },
    assignments: [
      { package: "x@2", checksum: "sha256:b", targets: ["all"], exclude: [] },
      { package: "y@1", checksum: "sha256:y", targets: ["testing.hannes"], exclude: [] },
    ],
    writeAssignments: (doc) => written.push(doc),
  });
  assert.deepEqual(result, {
    from: { package: "x@2", checksum: "sha256:b" },
    to: { package: "x@1", checksum: "sha256:a" },
  });
  assert.deepEqual(written[0].assignments[0], {
    package: "x@1",
    checksum: "sha256:a",
    targets: ["all"],
    exclude: [],
  });
  assert.deepEqual(written[0].assignments[1].package, "y@1");
  assert.throws(
    () =>
      rollbackCapability({
        current: { package: "x@2", checksum: "sha256:b" },
        prior: {},
        assignments: [],
        writeAssignments: () => {},
      }),
    /ROLLBACK_TARGET_NOT_INSTALLED/
  );
});

test("active run references are read from run audit records", () => {
  const runs = tmpdir("tu-life-runs-");
  const runDir = path.join(runs, "run-1");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "STATE.json"),
    JSON.stringify({ status: "watching" })
  );
  fs.writeFileSync(
    path.join(runDir, "EFFECTIVE_CAPABILITIES.json"),
    JSON.stringify({
      schema_version: 1,
      specialist_id: "testing.hannes",
      packages: [{ package: "x@1", checksum: "sha256:a" }],
    })
  );
  const doneDir = path.join(runs, "run-2");
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(
    path.join(doneDir, "STATE.json"),
    JSON.stringify({ status: "done" })
  );
  fs.writeFileSync(
    path.join(doneDir, "EFFECTIVE_CAPABILITIES.json"),
    JSON.stringify({
      schema_version: 1,
      specialist_id: "testing.hannes",
      packages: [{ package: "z@1", checksum: "sha256:z" }],
    })
  );

  const active = activeRunCapabilityReferences({ env: { TEAM_UP_RUNS: runs } });
  assert.deepEqual(
    active.map((item) => item.runId),
    ["run-1"]
  );
  assert.deepEqual(active[0].capabilities, [
    { package: "x@1", checksum: "sha256:a" },
  ]);
});
