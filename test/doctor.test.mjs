import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnose } from "../src/doctor.mjs";

// The whole world a diagnosis may see. O9K_HOME is named too because the read
// paths fall back to the legacy home for migration, and an unnamed one is the
// host's — which is how the host's roster reached these tests to begin with.
function homeEnv(home) {
  return { TEAM_UP_HOME: home, O9K_HOME: home };
}

function withHome(state, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    for (const [name, doc] of Object.entries(state)) {
      fs.writeFileSync(path.join(home, name), JSON.stringify(doc));
    }
    return fn(homeEnv(home));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const INDEX = {
  specialists: {
    "testing.tessa": {
      id: "testing.tessa",
      version: "0.1.0",
      checksum: "sha256:aaa",
      path: "/nowhere",
    },
  },
};

test("a rename leaves an assignment that delivers nothing", () => {
  // testing.hannes was renamed to testing.tessa; the assignment still names
  // the old id, matches nobody, and reports no error anywhere.
  const report = withHome(
    {
      "specialists-index.json": INDEX,
      "capability-assignments.json": {
        schema_version: 1,
        assignments: [
          { package: "style.caveman@0.1.0", checksum: "sha256:bbb", targets: ["testing.hannes"], exclude: [] },
        ],
      },
    },
    diagnose
  );
  const target = report.findings.find((f) => f.kind === "assignment_unknown_target");
  assert.ok(target, "the stale target must be reported");
  assert.equal(target.id, "testing.hannes");
  assert.equal(target.severity, "medium");
});

test("a stale exclusion is worse than a stale target and ranks higher", () => {
  const report = withHome(
    {
      "specialists-index.json": INDEX,
      "capability-assignments.json": {
        schema_version: 1,
        assignments: [
          { package: "style.caveman@0.1.0", checksum: "sha256:bbb", targets: ["all"], exclude: ["testing.hannes"] },
        ],
      },
    },
    diagnose
  );
  const excluded = report.findings.find((f) => f.field === "exclude");
  assert.ok(excluded);
  // targets:["all"] plus a dead exclusion means the package now reaches the
  // specialist it was meant to be kept from.
  assert.equal(excluded.severity, "high");
  assert.equal(report.counts.high >= 1, true);
});

test("the literal all target is not a specialist id", () => {
  const report = withHome(
    {
      "specialists-index.json": INDEX,
      "capability-assignments.json": {
        schema_version: 1,
        assignments: [
          { package: "style.caveman@0.1.0", checksum: "sha256:bbb", targets: ["all"], exclude: [] },
        ],
      },
    },
    diagnose
  );
  assert.equal(report.findings.some((f) => f.kind === "assignment_unknown_target"), false);
});

test("a superseded approval row is not a finding when a current one covers it", () => {
  // Approving a new version leaves the old row behind. That is what an upgrade
  // looks like, not a problem: the launcher matches on checksum, so the old row
  // is never selected. Reporting it made every upgrade produce a finding.
  const report = withHome(
    {
      "specialists-index.json": INDEX,
      "approvals.json": {
        approvals: {
          old: { id: "testing.tessa", version: "0.0.9", checksum: "sha256:old", project: "/p" },
          now: { id: "testing.tessa", version: "0.1.0", checksum: "sha256:aaa", project: "/p" },
        },
      },
    },
    diagnose
  );
  assert.equal(report.findings.some((f) => f.kind === "approval_stale_version"), false);
});

test("a superseded row for a different project is still reported", () => {
  const report = withHome(
    {
      "specialists-index.json": INDEX,
      "approvals.json": {
        approvals: {
          old: { id: "testing.tessa", version: "0.0.9", checksum: "sha256:old", project: "/other" },
          now: { id: "testing.tessa", version: "0.1.0", checksum: "sha256:aaa", project: "/p" },
        },
      },
    },
    diagnose
  );
  const finding = report.findings.find((f) => f.kind === "approval_stale_version");
  assert.ok(finding, "coverage is per project, not per specialist");
});

test("a stale approval checksum and a vanished project are both reported", () => {
  const report = withHome(
    {
      "specialists-index.json": INDEX,
      "approvals.json": {
        approvals: {
          k1: {
            id: "testing.tessa",
            version: "0.0.9",
            checksum: "sha256:old",
            project: "/definitely/not/here",
          },
        },
      },
    },
    diagnose
  );
  assert.ok(report.findings.some((f) => f.kind === "approval_stale_version"));
  assert.ok(report.findings.some((f) => f.kind === "approval_missing_project"));
});

test("a pin left behind by a rename is reported", () => {
  const report = withHome(
    {
      "specialists-index.json": INDEX,
      "specialists-pins.json": {
        pins: { "testing.hannes": { id: "testing.hannes", version: "0.1.0", checksum: "sha256:aaa" } },
      },
    },
    diagnose
  );
  assert.ok(report.findings.some((f) => f.kind === "pin_unknown_specialist"));
});

function installedPackage(home, manifest) {
  const dir = path.join(home, "specialists", manifest.id, manifest.version, "abc");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "instructions.md"), "hi\n");
  return dir;
}

// One cell, and a valid one: the doctor resolves against the roster of the
// home it is given, so this fixture is the whole world these two tests see.
// It has to survive validateRoster (an invalid roster exits the process) and
// reach the resolver, or the assertions below would be about nothing.
const ROSTER_FRONTIER_ONLY = {
  schema_version: 1,
  models: {
    "some-frontier": {
      tier: "frontier",
      reasoning: { max: "high", medium: "medium", low: "low" },
      cli: ["claude"],
      account: "a",
    },
  },
  accounts: { a: { kind: "subscription", enabled: true } },
  clis: { claude: { cmd: ["claude"] } },
};

test("a specialist no roster model can satisfy is reported before launch", () => {
  // coding.codey was built, published, installed and approved on this host and
  // could never have run. Nothing between building it and running it said so.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    const manifest = {
      schema_version: 1,
      id: "coding.example",
      version: "0.1.0",
      display_name: "Example",
      call_types: ["delegate"],
      output_contract: "team-up.result/v1",
      capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
      permissions: { filesystem: "project", writes: true, network: false, commands: [] },
      model_profile: { tier: "high", reasoning: "medium" },
    };
    const dir = installedPackage(home, manifest);
    fs.writeFileSync(
      path.join(home, "specialists-index.json"),
      JSON.stringify({
        specialists: {
          "coding.example": {
            id: manifest.id,
            version: manifest.version,
            checksum: "sha256:abc",
            path: dir,
          },
        },
      })
    );
    fs.writeFileSync(path.join(home, "roster.json"), JSON.stringify(ROSTER_FRONTIER_ONLY));

    const report = diagnose(homeEnv(home));
    const finding = report.findings.find((f) => f.kind === "no_model_for_profile");
    assert.ok(finding, "a profile no cell satisfies must be reported");
    assert.equal(finding.id, "coding.example");
    assert.equal(finding.severity, "high");
    // The reasons come from the real resolver, so they say why rather than
    // just that it failed — and they are about the fixture cell only. A host
    // model appearing here means the doctor read a roster it was not given.
    assert.deepEqual(finding.skipped, [
      { model: "some-frontier", reason: "tier frontier != high" },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a satisfiable profile is not reported", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    const manifest = {
      schema_version: 1,
      id: "review.example",
      version: "0.1.0",
      display_name: "Example",
      call_types: ["review"],
      output_contract: "team-up.result/v1",
      capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
      permissions: { filesystem: "project_readonly", writes: false, network: false, commands: [] },
      model_profile: { tier: "frontier", reasoning: "max" },
    };
    const dir = installedPackage(home, manifest);
    fs.writeFileSync(
      path.join(home, "specialists-index.json"),
      JSON.stringify({
        specialists: {
          "review.example": { id: manifest.id, version: manifest.version, checksum: "sha256:abc", path: dir },
        },
      })
    );
    fs.writeFileSync(path.join(home, "roster.json"), JSON.stringify(ROSTER_FRONTIER_ONLY));

    const report = diagnose(homeEnv(home));
    assert.equal(report.findings.some((f) => f.kind === "no_model_for_profile"), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a clean install reports ok", () => {
  const report = withHome({ "specialists-index.json": INDEX }, diagnose);
  assert.equal(report.ok, true);
  assert.deepEqual(report.counts, { high: 0, medium: 0, low: 0 });
  assert.equal(report.checked.specialists, 1);
});

/**
 * The drift finding exists because the old signal was indirect: drift showed
 * up as `no_model_for_profile`, named after the roster, and only when a
 * specialist with a model_profile happened to be installed. Uninstall the
 * specialists and the host is equally unable to launch anything, with a clean
 * report. This finding does not depend on any of that.
 */
test("a harness whose CLI updated past its verified version is reported", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    const dir = path.join(home, "harness-verification", "claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "2.1.252.json"),
      JSON.stringify({
        adapter: "claude",
        cli_version: "2.1.252",
        status: "verified",
        checked_at: "2026-09-01T09:57:52.333Z",
      })
    );
    const report = diagnose(homeEnv(home), { execFileSync: () => "2.1.259 (Claude Code)\n" });
    const finding = report.findings.find((f) => f.kind === "harness_version_drift");
    assert.ok(finding, "drift must be reported on its own, not via a specialist");
    assert.equal(finding.severity, "high");
    assert.equal(finding.installed, "2.1.259");
    assert.equal(finding.last_verified, "2.1.252");
    assert.match(finding.fix, /harness verify claude/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an adapter with no record at all is not reported as drift", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    // Nothing planted: a fresh home has never verified anything, and saying
    // "it stopped working" about that would be false.
    const report = diagnose(homeEnv(home), { execFileSync: () => "2.1.259 (Claude Code)\n" });
    assert.equal(report.findings.some((f) => f.kind === "harness_version_drift"), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
