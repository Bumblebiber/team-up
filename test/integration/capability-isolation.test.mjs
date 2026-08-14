import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importLocalCapability, listInstalledCapabilities } from "../../src/capabilities/store.mjs";
import {
  enableCapability,
  disableCapability,
  loadAssignments,
} from "../../src/capabilities/assignments.mjs";
import { resolveCapabilities } from "../../src/capabilities/resolve.mjs";
import { materializeCapabilityCapsule } from "../../src/capabilities/capsule.mjs";

const HANNES = "testing.hannes";
const RICK = "research.rick";

function tmpdir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function capabilitySource(id, body) {
  const source = tmpdir(`tu-cap-${id.replace(/\W/g, "-")}-`);
  fs.mkdirSync(path.join(source, "skills", id), { recursive: true });
  fs.writeFileSync(path.join(source, "skills", id, "SKILL.md"), body);
  fs.writeFileSync(
    path.join(source, "capability.json"),
    JSON.stringify({
      schema_version: 1,
      id,
      version: "1.0.0",
      display_name: id,
      provides: { skills: [`skills/${id}/SKILL.md`] },
      permissions: { network: false, commands: [] },
    })
  );
  return source;
}

function capsuleFor(specialistId, env, runRoot) {
  const resolution = resolveCapabilities({
    specialistId,
    assignments: loadAssignments({ env }).assignments,
    installed: listInstalledCapabilities({ env }),
  });
  return materializeCapabilityCapsule({
    runRoot,
    specialistId,
    packages: resolution.packages,
    exclusions: resolution.exclusions,
  });
}

function treeSize(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    total += entry.isDirectory() ? treeSize(abs) : fs.statSync(abs).size;
  }
  return total;
}

function seedPool(env) {
  const shared = importLocalCapability(
    capabilitySource("example.shared", "# Shared\n"),
    { env }
  );
  const hannesOnly = importLocalCapability(
    capabilitySource("example.hannes", "# Hannes only\n"),
    { env }
  );
  const rickOnly = importLocalCapability(
    capabilitySource("example.rick", "# Rick only\n"),
    { env }
  );

  // Shared goes to everyone, but Rick opts out. Each specialist-only package
  // is targeted explicitly.
  enableCapability({
    package: shared.package,
    checksum: shared.checksum,
    target: "all",
    env,
  });
  disableCapability({
    package: shared.package,
    checksum: shared.checksum,
    target: RICK,
    env,
  });
  enableCapability({
    package: hannesOnly.package,
    checksum: hannesOnly.checksum,
    target: HANNES,
    env,
  });
  enableCapability({
    package: rickOnly.package,
    checksum: rickOnly.checksum,
    target: RICK,
    env,
  });
  return { shared, hannesOnly, rickOnly };
}

test("two specialists never see each other's capabilities", () => {
  const env = { TEAM_UP_HOME: tmpdir("tu-iso-home-") };
  seedPool(env);

  const hannes = capsuleFor(HANNES, env, tmpdir("tu-iso-hannes-"));
  const rick = capsuleFor(RICK, env, tmpdir("tu-iso-rick-"));

  assert.deepEqual(
    hannes.packages.map((item) => item.id),
    ["example.hannes", "example.shared"]
  );
  assert.deepEqual(
    rick.packages.map((item) => item.id),
    ["example.rick"]
  );
  assert.equal(JSON.stringify(hannes).includes("example.rick"), false);
  assert.equal(JSON.stringify(rick).includes("example.hannes"), false);

  // The exclusion is recorded as an audit reason, not silently dropped.
  assert.deepEqual(rick.exclusions, [
    { package: "example.shared@1.0.0", reason: `exclude:${RICK}` },
  ]);
});

test("an inert pool package changes neither prompt bytes nor MCP schema bytes", () => {
  const env = { TEAM_UP_HOME: tmpdir("tu-iso-home-") };
  seedPool(env);

  const beforeHannes = tmpdir("tu-iso-h1-");
  const beforeRick = tmpdir("tu-iso-r1-");
  capsuleFor(HANNES, env, beforeHannes);
  capsuleFor(RICK, env, beforeRick);

  // Installed but never assigned: it must stay completely inert.
  importLocalCapability(
    capabilitySource("example.inert", `# Inert ${"x".repeat(4000)}\n`),
    { env }
  );

  const afterHannes = tmpdir("tu-iso-h2-");
  const afterRick = tmpdir("tu-iso-r2-");
  const hannesRecord = capsuleFor(HANNES, env, afterHannes);
  const rickRecord = capsuleFor(RICK, env, afterRick);

  for (const [before, after] of [
    [beforeHannes, afterHannes],
    [beforeRick, afterRick],
  ]) {
    assert.equal(
      treeSize(path.join(before, "context")),
      treeSize(path.join(after, "context"))
    );
    assert.equal(
      treeSize(path.join(before, "harness")),
      treeSize(path.join(after, "harness"))
    );
  }
  assert.equal(JSON.stringify(hannesRecord).includes("example.inert"), false);
  assert.equal(JSON.stringify(rickRecord).includes("example.inert"), false);
});

test("re-enabling removes the exclusion without reinstalling", () => {
  const env = { TEAM_UP_HOME: tmpdir("tu-iso-home-") };
  const { shared } = seedPool(env);
  const installedBefore = listInstalledCapabilities({ env }).length;

  enableCapability({
    package: shared.package,
    checksum: shared.checksum,
    target: RICK,
    env,
  });

  const rick = capsuleFor(RICK, env, tmpdir("tu-iso-rick-"));
  assert.deepEqual(
    rick.packages.map((item) => item.id).sort(),
    ["example.rick", "example.shared"]
  );
  assert.equal(listInstalledCapabilities({ env }).length, installedBefore);
});
