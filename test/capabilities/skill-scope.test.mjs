import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertScopeAllowsTarget,
  capabilityScope,
  providedSkillNames,
  skillScopeFromText,
  skillScopeFromFile,
} from "../../src/capabilities/skill-scope.mjs";
import { normalizeCapabilityManifest } from "../../src/capabilities/manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function pkg(skills) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-scope-"));
  const provides = [];
  for (const [name, scope] of Object.entries(skills)) {
    fs.mkdirSync(path.join(dir, "skills", name), { recursive: true });
    const meta = scope ? `metadata:\n  team-up-scope: ${scope}\n` : "";
    fs.writeFileSync(path.join(dir, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: d\n${meta}---\n\n# ${name}\n`);
    provides.push(`skills/${name}/SKILL.md`);
  }
  return { dir, manifest: { id: "p", provides: { skills: provides } } };
}

test("scope is read from frontmatter, nested under metadata or not", () => {
  assert.equal(skillScopeFromText("---\nname: a\nmetadata:\n  team-up-scope: main\n---\nbody"), "main");
  assert.equal(skillScopeFromText("---\nteam-up-scope: \"shared\"\n---\n"), "shared");
  assert.equal(skillScopeFromText("---\nname: a\n---\nteam-up-scope: main\n"), null,
    "a mention in the body is not a declaration");
  assert.equal(skillScopeFromText("# no frontmatter\n"), null);
  assert.throws(() => skillScopeFromText("---\nteam-up-scope: everyone\n---\n"), /invalid team-up-scope/);
});

test("package scope comes from its skills or its manifest, and must agree", () => {
  assert.equal(capabilityScope(pkg({ a: null }).manifest, pkg({ a: null }).dir), null);
  const main = pkg({ a: "main" });
  assert.equal(capabilityScope(main.manifest, main.dir), "main");
  const mixed = pkg({ a: "main", b: "specialist" });
  assert.throws(() => capabilityScope(mixed.manifest, mixed.dir), /CAPABILITY_SCOPE_CONFLICT/);
  const declared = pkg({ a: "main" });
  assert.throws(() => capabilityScope({ ...declared.manifest, scope: "shared" }, declared.dir),
    /CAPABILITY_SCOPE_CONFLICT/);
});

test("each layer only reaches its own targets", () => {
  assert.throws(() => assertScopeAllowsTarget("main", "all"), /CAPABILITY_SCOPE_MAIN/);
  assert.throws(() => assertScopeAllowsTarget("main", "coding.codey"), /CAPABILITY_SCOPE_MAIN/);
  assert.doesNotThrow(() => assertScopeAllowsTarget("main", "host"));
  assert.throws(() => assertScopeAllowsTarget("specialist", "host"), /CAPABILITY_SCOPE_SPECIALIST/);
  for (const target of ["host", "all", "coding.codey"]) {
    assert.doesNotThrow(() => assertScopeAllowsTarget("shared", target));
    assert.doesNotThrow(() => assertScopeAllowsTarget(null, target));
  }
});

test("skill names follow the capsule's placement rule", () => {
  assert.deepEqual(providedSkillNames({ id: "x.y", provides: {
    skills: ["skills/caveman/SKILL.md", "skills/other", "SKILL.md"],
  } }), ["caveman", "other", "x.y"]);
});

test("auto_invoke names one skill the package provides", () => {
  const base = {
    schema_version: 1, id: "s", version: "1", display_name: "S",
    provides: { skills: ["skills/caveman/SKILL.md"] },
  };
  assert.deepEqual(normalizeCapabilityManifest({ ...base, auto_invoke: ["caveman"] }).auto_invoke, ["caveman"]);
  assert.throws(() => normalizeCapabilityManifest({ ...base, auto_invoke: ["other"] }), /does not provide/);
  assert.throws(() => normalizeCapabilityManifest({ ...base, auto_invoke: ["caveman", "caveman"] }), /at most one/);
  assert.throws(() => normalizeCapabilityManifest({ ...base, auto_invoke: "caveman" }), /at most one/);
  assert.throws(() => normalizeCapabilityManifest({ ...base, scope: "everyone" }), /scope must be/);
});

test("every supervisor skill in this repo is main-only and caveman is shared", () => {
  for (const name of fs.readdirSync(path.join(ROOT, "skills"))) {
    assert.equal(skillScopeFromFile(path.join(ROOT, "skills", name, "SKILL.md")), "main", name);
  }
  assert.equal(skillScopeFromFile(path.join(
    ROOT, "capabilities", "style.caveman", "skills", "caveman", "SKILL.md")), "shared");
});
