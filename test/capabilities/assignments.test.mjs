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

test("all remains dynamic and specialist disable adds an exclusion", () => {
  const env = { TEAM_UP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "tu-")) };
  enableCapability({
    package: "o9k.caveman@1.2.0", checksum: "sha256:abc", target: "all", env,
  });
  disableCapability({
    package: "o9k.caveman@1.2.0", checksum: "sha256:abc",
    target: "research.reanna", env,
  });
  assert.deepEqual(loadAssignments({ env }).assignments[0], {
    package: "o9k.caveman@1.2.0",
    checksum: "sha256:abc",
    targets: ["all"],
    exclude: ["research.reanna"],
  });
  enableCapability({
    package: "o9k.caveman@1.2.0", checksum: "sha256:abc",
    target: "research.reanna", env,
  });
  assert.deepEqual(loadAssignments({ env }).assignments[0].exclude, []);
});
