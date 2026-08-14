import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scanCapabilityRoots,
  normalizeDetectedCandidate,
} from "../../src/capabilities/scan.mjs";
import { importLocalCapability } from "../../src/capabilities/store.mjs";

function tmpdir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test("scan reports candidates without importing or changing sources", () => {
  const root = tmpdir("tu-scan-");
  const skill = path.join(root, "skills", "caveman");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "# Caveman\n");
  const before = fs.readFileSync(path.join(skill, "SKILL.md"));

  const result = scanCapabilityRoots([path.join(root, "skills")]);

  assert.deepEqual(
    result.map((item) => item.type),
    ["skill"]
  );
  assert.equal(result[0].path, skill);
  assert.deepEqual(fs.readFileSync(path.join(skill, "SKILL.md")), before);
  assert.equal(fs.existsSync(path.join(root, "capability-pool")), false);
});

test("scan recognizes plugin, mcp and bundle layouts", () => {
  const root = tmpdir("tu-scan-");
  for (const [dir, file] of [
    ["plug", ".claude-plugin/plugin.json"],
    ["srv", "mcp.json"],
    ["bundle", "capability.json"],
  ]) {
    const abs = path.join(root, dir, path.dirname(file));
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(root, dir, file), "{}\n");
  }
  const result = scanCapabilityRoots([root]);
  assert.deepEqual(
    result.map((item) => item.type).sort(),
    ["bundle", "mcp", "plugin"]
  );
});

test("a directory with two markers is ambiguous, never guessed", () => {
  const root = tmpdir("tu-scan-");
  const both = path.join(root, "both");
  fs.mkdirSync(both, { recursive: true });
  fs.writeFileSync(path.join(both, "SKILL.md"), "# x\n");
  fs.writeFileSync(path.join(both, "mcp.json"), "{}\n");

  const [candidate] = scanCapabilityRoots([root]);
  assert.equal(candidate.type, "ambiguous");
  assert.deepEqual(
    candidate.markers.map((item) => item.type).sort(),
    ["mcp", "skill"]
  );
  assert.throws(
    () =>
      normalizeDetectedCandidate(candidate, {
        id: "x",
        version: "1",
        displayName: "X",
      }),
    /CAPABILITY_TYPE_REQUIRED/
  );
});

test("scan never follows a symlinked directory out of the root", () => {
  const root = tmpdir("tu-scan-");
  const outside = tmpdir("tu-outside-");
  fs.mkdirSync(path.join(outside, "secret"), { recursive: true });
  fs.writeFileSync(path.join(outside, "secret", "SKILL.md"), "# secret\n");
  fs.symlinkSync(path.join(outside, "secret"), path.join(root, "linked"));

  assert.deepEqual(scanCapabilityRoots([root]), []);
});

test("a detected skill imports without touching the source directory", () => {
  const source = tmpdir("tu-detect-");
  fs.writeFileSync(path.join(source, "SKILL.md"), "# Detected\n");
  const before = fs.readdirSync(source);

  const manifest = normalizeDetectedCandidate(
    { type: "skill", path: source },
    { id: "detected.skill", version: "1.0.0", displayName: "Detected" }
  );
  const env = { TEAM_UP_HOME: tmpdir("tu-home-") };
  const record = importLocalCapability(source, {
    env,
    manifestOverride: manifest,
  });

  assert.deepEqual(record.provides.skills, ["SKILL.md"]);
  assert.deepEqual(fs.readdirSync(source), before);
  assert.equal(fs.existsSync(path.join(source, "capability.json")), false);
});

test("detected imports require identity and reject unsupported types", () => {
  assert.throws(
    () => normalizeDetectedCandidate({ type: "skill", path: "/x" }, { id: "x" }),
    /requires id, version/
  );
  assert.throws(
    () =>
      normalizeDetectedCandidate(
        { type: "nonsense", path: "/x" },
        { id: "x", version: "1", displayName: "X" }
      ),
    /unsupported detected capability type/
  );
});

test("a plugin or framework candidate can point at an explicit relative path", () => {
  const manifest = normalizeDetectedCandidate(
    { type: "plugin", path: "/x" },
    { id: "p", version: "1", displayName: "P", relPath: "plugin" }
  );
  assert.deepEqual(manifest.provides.plugins, ["plugin"]);
  assert.deepEqual(manifest.provides.skills, []);
});
