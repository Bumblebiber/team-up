import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enableCapability,
  disableCapability,
  loadAssignments,
} from "../../src/capabilities/assignments.mjs";

function home() {
  return {
    TEAM_UP_HOME: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tu-"))),
  };
}

test("all remains dynamic and specialist disable adds an exclusion", () => {
  const env = home();
  enableCapability({
    package: "o9k.caveman@1.2.0",
    checksum: "sha256:abc",
    target: "all",
    env,
  });
  disableCapability({
    package: "o9k.caveman@1.2.0",
    checksum: "sha256:abc",
    target: "research.hugo",
    env,
  });
  assert.deepEqual(loadAssignments({ env }).assignments[0], {
    package: "o9k.caveman@1.2.0",
    checksum: "sha256:abc",
    targets: ["all"],
    exclude: ["research.hugo"],
  });
  enableCapability({
    package: "o9k.caveman@1.2.0",
    checksum: "sha256:abc",
    target: "research.hugo",
    env,
  });
  assert.deepEqual(loadAssignments({ env }).assignments[0].exclude, []);
});

test("explicit targets disable by removal, not exclusion", () => {
  const env = home();
  enableCapability({
    package: "a@1",
    checksum: "sha256:a",
    target: "testing.hannes",
    env,
  });
  enableCapability({
    package: "a@1",
    checksum: "sha256:a",
    target: "research.hugo",
    env,
  });
  assert.deepEqual(loadAssignments({ env }).assignments[0].targets, [
    "research.hugo",
    "testing.hannes",
  ]);
  disableCapability({
    package: "a@1",
    checksum: "sha256:a",
    target: "research.hugo",
    env,
  });
  const row = loadAssignments({ env }).assignments[0];
  assert.deepEqual(row.targets, ["testing.hannes"]);
  assert.deepEqual(row.exclude, []);
});

test("removing the last target drops the assignment row", () => {
  const env = home();
  enableCapability({ package: "a@1", checksum: "sha256:a", target: "all", env });
  disableCapability({ package: "a@1", checksum: "sha256:a", target: "all", env });
  assert.deepEqual(loadAssignments({ env }).assignments, []);
});

test("assignments for different checksums stay separate rows", () => {
  const env = home();
  enableCapability({ package: "a@1", checksum: "sha256:a", target: "all", env });
  enableCapability({
    package: "a@1",
    checksum: "sha256:b",
    target: "testing.hannes",
    env,
  });
  assert.equal(loadAssignments({ env }).assignments.length, 2);
});

test("mutations reject malformed input before writing", () => {
  const env = home();
  assert.throws(
    () => enableCapability({ package: "no-version", checksum: "sha256:a", target: "all", env }),
    /required/
  );
  assert.throws(
    () => enableCapability({ package: "a@1", checksum: "abc", target: "all", env }),
    /required/
  );
  assert.throws(
    () => enableCapability({ package: "a@1", checksum: "sha256:a", env }),
    /required/
  );
  assert.deepEqual(loadAssignments({ env }).assignments, []);
});
