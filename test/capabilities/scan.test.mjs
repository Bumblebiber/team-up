import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanCapabilityRoots, normalizeDetectedCandidate } from "../../src/capabilities/scan.mjs";
import { importLocalCapability } from "../../src/capabilities/store.mjs";

test("scan reports candidates without importing or changing sources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-scan-"));
  const skill = path.join(root, "skills", "caveman");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "# Caveman\n");
  const before = fs.readFileSync(path.join(skill, "SKILL.md"));
  const result = scanCapabilityRoots([root]);
  assert.deepEqual(result.map((item) => item.type), ["skill"]);
  assert.equal(result[0].path, skill);
  assert.deepEqual(fs.readFileSync(path.join(skill, "SKILL.md")), before);
  assert.equal(fs.existsSync(path.join(root, "capability-pool")), false);
});

test("detected skill import leaves source untouched", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-scan-home-"));
  const skill = fs.mkdtempSync(path.join(os.tmpdir(), "tu-skill-"));
  fs.writeFileSync(path.join(skill, "SKILL.md"), "# Only\n");
  const before = fs.readdirSync(skill);
  const manifest = normalizeDetectedCandidate({ type: "skill", path: skill }, {
    id: "local.only", version: "1", displayName: "Only",
  });
  importLocalCapability(skill, {
    env: { TEAM_UP_HOME: home },
    manifestOverride: manifest,
  });
  assert.deepEqual(fs.readdirSync(skill), before);
});
