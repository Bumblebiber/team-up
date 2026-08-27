import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importLocalCapability } from "../../src/capabilities/store.mjs";
import { enableCapability, disableCapability, loadAssignments } from "../../src/capabilities/assignments.mjs";
import { listInstalledCapabilities } from "../../src/capabilities/store.mjs";
import { resolveCapabilities } from "../../src/capabilities/resolve.mjs";
import { materializeCapabilityCapsule } from "../../src/capabilities/capsule.mjs";

function writeCap(root, { id, version, skill }) {
  fs.mkdirSync(path.join(root, "skills", skill), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", skill, "SKILL.md"), `# ${skill}\n`);
  fs.writeFileSync(path.join(root, "capability.json"), JSON.stringify({
    schema_version: 1,
    id,
    version,
    display_name: id,
    provides: { skills: [`skills/${skill}/SKILL.md`] },
    permissions: { network: false, commands: [] },
  }));
  return root;
}

test("two specialists resolve isolated capsules from shared pool", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-home-"));
  const env = { TEAM_UP_HOME: home };
  const shared = writeCap(fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-")), {
    id: "example.shared", version: "1", skill: "shared",
  });
  const hannesOnly = writeCap(fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-")), {
    id: "example.hannes", version: "1", skill: "hannes",
  });
  const reannaOnly = writeCap(fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-")), {
    id: "example.reanna", version: "1", skill: "reanna",
  });
  const inert = writeCap(fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-")), {
    id: "example.inert", version: "1", skill: "inert",
  });
  const sharedRec = importLocalCapability(shared, { env });
  const hannesRec = importLocalCapability(hannesOnly, { env });
  const reannaRec = importLocalCapability(reannaOnly, { env });
  importLocalCapability(inert, { env });
  enableCapability({
    package: sharedRec.package, checksum: sharedRec.checksum, target: "all", env,
  });
  disableCapability({
    package: sharedRec.package, checksum: sharedRec.checksum, target: "research.reanna", env,
  });
  enableCapability({
    package: hannesRec.package, checksum: hannesRec.checksum, target: "testing.hannes", env,
  });
  enableCapability({
    package: reannaRec.package, checksum: reannaRec.checksum, target: "research.reanna", env,
  });
  const installed = listInstalledCapabilities({ env });
  const assignments = loadAssignments({ env }).assignments;
  const hannesResolved = resolveCapabilities({
    specialistId: "testing.hannes", assignments, installed,
  });
  const reannaResolved = resolveCapabilities({
    specialistId: "research.reanna", assignments, installed,
  });
  const hannesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-run-"));
  const reannaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-run-"));
  const hannes = materializeCapabilityCapsule({
    runRoot: hannesRoot,
    specialistId: "testing.hannes",
    packages: hannesResolved.packages,
    exclusions: hannesResolved.exclusions,
  });
  const reanna = materializeCapabilityCapsule({
    runRoot: reannaRoot,
    specialistId: "research.reanna",
    packages: reannaResolved.packages,
    exclusions: reannaResolved.exclusions,
  });
  assert.deepEqual(hannes.packages.map((x) => x.id).sort(),
    ["example.hannes", "example.shared"]);
  assert.deepEqual(reanna.packages.map((x) => x.id), ["example.reanna"]);
  assert.equal(JSON.stringify(hannes).includes("example.reanna"), false);
  assert.equal(JSON.stringify(reanna).includes("example.hannes"), false);
  const beforePrompt = hannes.totals.estimated_description_tokens;
  const beforeMcp = hannes.totals.mcp_tool_count;
  assert.equal(beforePrompt, materializeCapabilityCapsule({
    runRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-run-")),
    specialistId: "testing.hannes",
    packages: hannesResolved.packages,
    exclusions: hannesResolved.exclusions,
  }).totals.estimated_description_tokens);
  assert.equal(beforeMcp, 0);
});
