import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnose } from "../src/doctor.mjs";

function withHome(state, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    for (const [name, doc] of Object.entries(state)) {
      fs.writeFileSync(path.join(home, name), JSON.stringify(doc));
    }
    return fn({ TEAM_UP_HOME: home });
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

test("a clean install reports ok", () => {
  const report = withHome({ "specialists-index.json": INDEX }, diagnose);
  assert.equal(report.ok, true);
  assert.deepEqual(report.counts, { high: 0, medium: 0, low: 0 });
  assert.equal(report.checked.specialists, 1);
});
