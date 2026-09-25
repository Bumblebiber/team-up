import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSpecialistsView } from "../../src/dashboard/specialists.mjs";

const CHECKSUM = "sha256:" + "a".repeat(64);
const CAP_CHECKSUM = "sha256:" + "b".repeat(64);

function plant(home) {
  const dir = path.join(home, "specialists", "coding.codey", "0.1.2", "aaa");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "specialist.json"),
    JSON.stringify({
      schema_version: 2,
      id: "coding.codey",
      display_name: "Codey",
      version: "0.1.2",
      remit: ["implementing one ticket against a spec"],
      anti_remit: ["changing the spec"],
      call_types: ["delegate"],
      capabilities: { skills: ["implementing"], tools: ["filesystem.write"], mcps: [], frameworks: [] },
      permissions: { filesystem: "project", writes: true, network: false, commands: [] },
      budget: { timeout_seconds: 3600 },
    }),
  );
  const entry = {
    id: "coding.codey",
    version: "0.1.2",
    checksum: CHECKSUM,
    path: dir,
    installed_at: "2026-08-29T14:37:11.477Z",
  };
  fs.writeFileSync(
    path.join(home, "specialists-index.json"),
    JSON.stringify({ specialists: { "coding.codey": entry }, versions: { "coding.codey": [entry] } }),
  );
  fs.mkdirSync(path.join(home, "capability-pool"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "capability-pool", "index.json"),
    JSON.stringify({
      packages: [{
        package: "ponytail.build@4.8.4",
        id: "ponytail.build",
        version: "4.8.4",
        display_name: "Ponytail",
        checksum: CAP_CHECKSUM,
        provides: { skills: ["skills/ponytail/SKILL.md"], plugins: [], mcps: [], frameworks: [] },
      }],
    }),
  );
}

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-spec-"));
  const prev = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    plant(home);
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function assign(home, doc) {
  fs.writeFileSync(
    path.join(home, "capability-assignments.json"),
    JSON.stringify({ schema_version: 1, assignments: doc }),
  );
}

test("a specialist reports what its package bundles", () =>
  withHome(() => {
    const [codey] = buildSpecialistsView().specialists;
    assert.equal(codey.id, "coding.codey");
    assert.equal(codey.display_name, "Codey");
    assert.equal(codey.version, "0.1.2");
    assert.equal(codey.checksum, "a".repeat(12));
    assert.deepEqual(codey.bundled.skills, ["implementing"]);
    assert.equal(codey.permissions.writes, true);
    assert.deepEqual(codey.assigned, []);
    assert.equal(codey.error, null);
  }));

test("an assigned package shows up with the reason it applies", () =>
  withHome((home) => {
    assign(home, [
      { package: "ponytail.build@4.8.4", checksum: CAP_CHECKSUM, targets: ["all"], exclude: [] },
    ]);
    const [codey] = buildSpecialistsView().specialists;
    assert.equal(codey.assigned.length, 1);
    assert.equal(codey.assigned[0].package, "ponytail.build@4.8.4");
    assert.equal(codey.assigned[0].reason, "target:all");
    assert.deepEqual(codey.assigned[0].provides.skills, ["skills/ponytail/SKILL.md"]);
  }));

test("an exclusion keeps the package off the specialist and says so", () =>
  withHome((home) => {
    assign(home, [
      {
        package: "ponytail.build@4.8.4",
        checksum: CAP_CHECKSUM,
        targets: ["all"],
        exclude: ["coding.codey"],
      },
    ]);
    const [codey] = buildSpecialistsView().specialists;
    assert.deepEqual(codey.assigned, []);
    assert.equal(codey.exclusions[0].reason, "exclude:coding.codey");
  }));

test("an assignment pointing at a package the pool lacks is reported, not thrown", () =>
  withHome((home) => {
    assign(home, [
      { package: "ghost.pkg@1.0.0", checksum: CAP_CHECKSUM, targets: ["coding.codey"], exclude: [] },
    ]);
    const [codey] = buildSpecialistsView().specialists;
    assert.match(codey.error, /CAPABILITY_MISSING/);
    assert.deepEqual(codey.assigned, []);
  }));

test("only approvals matching the installed checksum count", () =>
  withHome((home) => {
    fs.writeFileSync(
      path.join(home, "approvals.json"),
      JSON.stringify({
        approvals: {
          a: { project: "/home/bbbee/projects/team-up", id: "coding.codey", version: "0.1.2", checksum: CHECKSUM },
          b: { project: "/home/bbbee/projects/old", id: "coding.codey", version: "0.1.1", checksum: "sha256:" + "c".repeat(64) },
        },
      }),
    );
    const [codey] = buildSpecialistsView().specialists;
    assert.deepEqual(codey.approved_for, ["/home/bbbee/projects/team-up"]);
  }));
