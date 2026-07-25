import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateCommandPolicy,
  commandPolicyChecksum,
  snapshotCommandPolicy,
} from "../../src/commands/policy.mjs";

const valid = {
  schema_version: 1,
  commands: {
    "project-test": {
      argv: ["npm", "test"],
      cwd: ".",
      timeout_seconds: 1800,
      environment: {},
    },
  },
};

test("validates fixed argv policy", () => {
  assert.deepEqual(validateCommandPolicy(valid), { ok: true, errors: [] });
});

test("rejects shell strings, cwd escape, env overrides, and unknown keys", () => {
  for (const policy of [
    { schema_version: 1, commands: { x: { argv: "npm test", cwd: "." } } },
    { schema_version: 1, commands: { x: { argv: ["sh", "-c", "npm test"], cwd: "." } } },
    { schema_version: 1, commands: { x: { argv: ["npm", "test"], cwd: "../escape" } } },
    { schema_version: 1, commands: { x: { argv: ["npm", "test"], cwd: ".", extra: true } } },
  ]) {
    assert.equal(validateCommandPolicy(policy).ok, false);
  }
});

test("snapshot is immutable and checksum bound", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-policy-"));
  const snap = snapshotCommandPolicy({ policy: valid, runDir });
  assert.equal(snap.checksum, commandPolicyChecksum(valid));
  assert.equal(fs.statSync(snap.path).mode & 0o222, 0);
});
