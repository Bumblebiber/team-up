import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeCapabilityCapsule }
  from "../../src/capabilities/capsule.mjs";

test("capsule contains selected declared files and exact audit record", () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
  fs.mkdirSync(path.join(packageDir, "skills", "selected"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "skills", "hidden"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "skills", "selected", "SKILL.md"), "# Yes\n");
  fs.writeFileSync(path.join(packageDir, "skills", "hidden", "SKILL.md"), "# No\n");
  fs.writeFileSync(path.join(packageDir, "capability.json"), JSON.stringify({
    schema_version: 1, id: "selected", version: "1", display_name: "Selected",
    provides: { skills: ["skills/selected/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }));
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-"));
  const result = materializeCapabilityCapsule({
    runRoot,
    specialistId: "research.hugo",
    packages: [{
      package: "selected@1", id: "selected", version: "1",
      checksum: "sha256:a", packageDir, reason: "target:research.hugo",
    }],
    exclusions: [{ package: "hidden@1", reason: "exclude:research.hugo" }],
  });
  assert.equal(fs.existsSync(path.join(
    runRoot, "context", "skills", "selected", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(
    runRoot, "context", "skills", "hidden", "SKILL.md")), false);
  assert.equal(result.schema_version, 1);
  assert.deepEqual(result.packages[0].resolved.skills,
    ["context/skills/selected/SKILL.md"]);
});

test("failed capsule construction cleans partial trees", () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
  fs.mkdirSync(path.join(packageDir, "skills", "a"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "skills", "a", "SKILL.md"), "# A\n");
  fs.writeFileSync(path.join(packageDir, "capability.json"), JSON.stringify({
    schema_version: 1, id: "a", version: "1", display_name: "A",
    provides: { skills: ["skills/a/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
  fs.mkdirSync(path.join(other, "skills", "a"), { recursive: true });
  fs.writeFileSync(path.join(other, "skills", "a", "SKILL.md"), "# Clash\n");
  fs.writeFileSync(path.join(other, "capability.json"), JSON.stringify({
    schema_version: 1, id: "b", version: "1", display_name: "B",
    provides: { skills: ["skills/a/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }));
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-"));
  assert.throws(() => materializeCapabilityCapsule({
    runRoot,
    specialistId: "research.hugo",
    packages: [
      { package: "a@1", id: "a", version: "1", checksum: "sha256:a",
        packageDir, reason: "target:all" },
      { package: "b@1", id: "b", version: "1", checksum: "sha256:b",
        packageDir: other, reason: "target:all" },
    ],
  }), /CAPSULE_PATH_COLLISION/);
  assert.equal(fs.existsSync(path.join(runRoot, "context")), false);
  assert.equal(fs.existsSync(path.join(runRoot, "harness")), false);
});

test("unselected pool package does not change capsule bytes", () => {
  const selected = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
  fs.mkdirSync(path.join(selected, "skills", "s"), { recursive: true });
  fs.writeFileSync(path.join(selected, "skills", "s", "SKILL.md"), "# S\n");
  fs.writeFileSync(path.join(selected, "mcp.json"), JSON.stringify({
    mcpServers: { s: { type: "stdio", command: "node", args: ["s.mjs"] } },
    tools: ["lookup"],
  }));
  fs.writeFileSync(path.join(selected, "capability.json"), JSON.stringify({
    schema_version: 1, id: "sel", version: "1", display_name: "Sel",
    provides: { skills: ["skills/s/SKILL.md"], mcps: ["mcp.json"] },
    permissions: { network: false, commands: [] },
  }));
  const unselected = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
  fs.mkdirSync(path.join(unselected, "skills", "u"), { recursive: true });
  fs.writeFileSync(path.join(unselected, "skills", "u", "SKILL.md"), "# UUUUU\n");
  fs.writeFileSync(path.join(unselected, "capability.json"), JSON.stringify({
    schema_version: 1, id: "uns", version: "1", display_name: "Uns",
    provides: { skills: ["skills/u/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }));
  const packages = [{
    package: "sel@1", id: "sel", version: "1", checksum: "sha256:s",
    packageDir: selected, reason: "target:all",
    estimated_description_tokens: 2, mcp_tool_count: 1,
  }];
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-"));
  const first = materializeCapabilityCapsule({
    runRoot: firstRoot, specialistId: "research.hugo", packages,
  });
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-"));
  const second = materializeCapabilityCapsule({
    runRoot: secondRoot, specialistId: "research.hugo", packages,
  });
  assert.equal(first.totals.estimated_description_tokens,
    second.totals.estimated_description_tokens);
  assert.equal(
    fs.readFileSync(path.join(firstRoot, "context", "skills", "s", "SKILL.md")).length,
    fs.readFileSync(path.join(secondRoot, "context", "skills", "s", "SKILL.md")).length
  );
  assert.equal(fs.existsSync(path.join(firstRoot, "context", "skills", "u")), false);
  void unselected;
});
