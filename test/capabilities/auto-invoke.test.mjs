import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  autoInvokePrefix,
  materializeCapabilityCapsule,
} from "../../src/capabilities/capsule.mjs";
import { claudeAdapter } from "../../src/harness/claude.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function pkg({ id, skill, autoInvoke, scope }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
  fs.mkdirSync(path.join(dir, "skills", skill), { recursive: true });
  const meta = scope ? `metadata:\n  team-up-scope: ${scope}\n` : "";
  fs.writeFileSync(path.join(dir, "skills", skill, "SKILL.md"),
    `---\nname: ${skill}\ndescription: d\n${meta}---\n# ${skill}\n`);
  fs.writeFileSync(path.join(dir, "capability.json"), JSON.stringify({
    schema_version: 1, id, version: "1", display_name: id,
    ...(autoInvoke ? { auto_invoke: [skill] } : {}),
    provides: { skills: [`skills/${skill}/SKILL.md`] },
    permissions: { network: false, commands: [] },
  }));
  return { package: `${id}@1`, id, version: "1", checksum: "sha256:a", packageDir: dir, reason: "target:all" };
}

test("the capsule record carries each package's auto_invoke", () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-"));
  const effective = materializeCapabilityCapsule({
    runRoot, specialistId: "research.reanna",
    packages: [pkg({ id: "style.c", skill: "caveman", autoInvoke: true }),
      pkg({ id: "other", skill: "other" })],
  });
  assert.deepEqual(effective.packages.map((p) => p.auto_invoke), [["caveman"], []]);
  const onDisk = JSON.parse(fs.readFileSync(path.join(runRoot, "EFFECTIVE_CAPABILITIES.json"), "utf8"));
  assert.deepEqual(onDisk.packages[0].auto_invoke, ["caveman"]);
});

test("a main-only package never enters a capsule, whatever the assignment says", () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-"));
  assert.throws(() => materializeCapabilityCapsule({
    runRoot, specialistId: "coding.codey",
    packages: [pkg({ id: "mem", skill: "memory", scope: "main" })],
  }), /CAPABILITY_SCOPE_MAIN/);
  assert.equal(fs.existsSync(path.join(runRoot, "context")), false);
});

test("the launcher prefix is the harness's own invocation, first in the prompt", () => {
  const effective = { packages: [{ auto_invoke: ["caveman"] }, { auto_invoke: [] }] };
  const out = autoInvokePrefix(effective, (name) => claudeAdapter.skillInvocation(name));
  assert.equal(out.prefix, "/caveman\n\n");
  assert.deepEqual(out.skills, ["caveman"]);
  assert.equal(`${out.prefix}# Worker task`.startsWith("/caveman"), true);
});

test("no auto_invoke means no prefix; a harness without syntax is recorded, not guessed", () => {
  assert.deepEqual(autoInvokePrefix({ packages: [] }, () => "/x"),
    { skills: [], prefix: "", skipped: null });
  const out = autoInvokePrefix({ packages: [{ auto_invoke: ["caveman"] }] }, null);
  assert.equal(out.prefix, "");
  assert.match(out.skipped, /no skill invocation syntax/);
});

test("two packages that each want to open the prompt are refused", () => {
  assert.throws(() => autoInvokePrefix({
    packages: [{ auto_invoke: ["caveman"] }, { auto_invoke: ["terse"] }],
  }, (n) => `/${n}`), /AUTO_INVOKE_CONFLICT/);
});

test("the shipped caveman package opens worker prompts", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, "capabilities", "style.caveman", "capability.json"), "utf8"));
  assert.deepEqual(manifest.auto_invoke, ["caveman"]);
  assert.equal(manifest.scope, "shared");
});
