import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveRoster, validateRoster } from "../../src/roster/config.mjs";
import { applySpecialistAssignment, applyRoleEdit } from "../../src/dashboard/roles.mjs";
import { resolveProfile } from "../../src/roster/profile.mjs";

const roster = Object.freeze({
  accounts: { codex: { kind: "subscription", enabled: true } },
  clis: { codex: { cmd: ["codex", "{prompt}"] }, claude: { cmd: ["claude", "{prompt}"] } },
  models: {
    luna: { cli: ["codex"], account: "codex" },
    opus: { cli: ["claude"] },
  },
  roles: { implementer: { chain: ["codex:luna"] } },
});

test("a specialist is assigned a role, a chain of its own, or nothing", () => {
  const onRole = applySpecialistAssignment(roster, { id: "coding.codey", role: "implementer" });
  assert.deepEqual(onRole.specialists, { "coding.codey": { role: "implementer" } });
  assert.equal(roster.specialists, undefined, "the roster it was given is untouched");

  const own = applySpecialistAssignment(onRole, {
    id: "coding.codey", chain: [{ model: "opus", cli: "claude", effort: "max" }, { model: "luna", cli: "codex" }],
  });
  assert.deepEqual(own.specialists["coding.codey"], { chain: [{ model: "opus", cli: "claude", effort: "max" }, "codex:luna"] });
  assert.deepEqual(validateRoster(own).errors, []);
  assert.deepEqual(resolveProfile({ roster: own, specialistId: "coding.codey", harnessCapabilities: () => ({}) })
    .chain.map((c) => `${c.cli}:${c.model}@${c.effort}`), ["claude:opus@max", "codex:luna@null"]);

  assert.equal(applySpecialistAssignment(own, { id: "coding.codey" }).specialists, undefined);
});

test("an assignment that names a missing role or an unrunnable cell is refused", () => {
  assert.throws(() => applySpecialistAssignment(roster, { id: "x", role: "nope" }), /unknown role/);
  assert.throws(() => applySpecialistAssignment(roster, { id: "x", chain: [{ model: "opus", cli: "codex" }] }),
    /does not run on codex/);
  assert.throws(() => applySpecialistAssignment(roster, { id: "x", role: "implementer", chain: [] }), /not both/);
});

test("the validator wants exactly one of role or chain, and a role that exists", () => {
  const errs = (specialists) => validateRoster({ ...roster, specialists }).errors;
  assert.deepEqual(errs({ a: { role: "implementer" }, b: { chain: ["codex:luna"] } }), []);
  assert.match(errs({ a: {} }).join(), /exactly one of role or chain/);
  assert.match(errs({ a: { role: "implementer", chain: ["luna"] } }).join(), /exactly one of role or chain/);
  assert.match(errs({ a: { role: "gone" } }).join(), /not in roles/);
  assert.match(errs({ a: { chain: [] } }).join(), /non-empty/);
});

test("a role a specialist runs on cannot be deleted", () => {
  const assigned = applySpecialistAssignment(roster, { id: "coding.codey", role: "implementer" });
  assert.throws(() => applyRoleEdit(assigned, { role: "implementer", delete: true }),
    /coding\.codey run on implementer — reassign them first/);
});

test("a roster the validator rejects is never written, and a write keeps a backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-roster-"));
  try {
    const dest = path.join(dir, "roster.json");
    const env = { TEAM_UP_ROSTER: dest };
    fs.writeFileSync(dest, `${JSON.stringify(roster, null, 2)}\n`);

    assert.throws(() => saveRoster({ ...roster, specialists: { a: { role: "gone" } } }, { env }), /roster invalid/);
    assert.deepEqual(JSON.parse(fs.readFileSync(dest, "utf8")), roster, "file untouched");

    const written = saveRoster(applySpecialistAssignment(roster, { id: "a", role: "implementer" }), { env });
    assert.deepEqual(JSON.parse(fs.readFileSync(dest, "utf8")).specialists, { a: { role: "implementer" } });
    assert.deepEqual(JSON.parse(fs.readFileSync(written.backup, "utf8")), roster);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
