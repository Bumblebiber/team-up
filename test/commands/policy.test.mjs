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

test("snapshot is immutable, checksum bound, and outside worker-writable run dir", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-polhome-"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-policy-"));
  const prev = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    const snap = snapshotCommandPolicy({
      policy: valid,
      runId: path.basename(runDir),
      workerVisibleDir: path.join(runDir, "policy"),
    });
    assert.equal(snap.checksum, commandPolicyChecksum(valid));
    assert.equal(fs.statSync(snap.path).mode & 0o222, 0);
    assert.ok(snap.path.startsWith(path.join(home, "policy-snapshots")));
    assert.ok(!snap.path.startsWith(runDir));
    assert.ok(fs.existsSync(path.join(runDir, "policy", "commands.json")));
  } finally {
    if (prev === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
