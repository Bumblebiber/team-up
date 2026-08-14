import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  materializeCapabilityCapsule,
  buildStrictMcpConfig,
} from "../../src/capabilities/capsule.mjs";

function tmpdir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writePackage({ id, version = "1", provides, files }) {
  const packageDir = tmpdir(`tu-pkg-${id}-`);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(packageDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(packageDir, rel), body);
  }
  fs.writeFileSync(
    path.join(packageDir, "capability.json"),
    JSON.stringify({
      schema_version: 1,
      id,
      version,
      display_name: id,
      provides,
      permissions: { network: false, commands: [] },
    })
  );
  return {
    package: `${id}@${version}`,
    id,
    version,
    checksum: `sha256:${id}`,
    packageDir,
    reason: "target:all",
  };
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

test("capsule contains selected declared files and exact audit record", () => {
  const packageDir = tmpdir("tu-pkg-");
  fs.mkdirSync(path.join(packageDir, "skills", "selected"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "skills", "hidden"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "skills", "selected", "SKILL.md"), "# Yes\n");
  fs.writeFileSync(path.join(packageDir, "skills", "hidden", "SKILL.md"), "# No\n");
  fs.writeFileSync(
    path.join(packageDir, "capability.json"),
    JSON.stringify({
      schema_version: 1,
      id: "selected",
      version: "1",
      display_name: "Selected",
      provides: { skills: ["skills/selected/SKILL.md"] },
      permissions: { network: false, commands: [] },
    })
  );
  const runRoot = tmpdir("tu-run-");
  const result = materializeCapabilityCapsule({
    runRoot,
    specialistId: "research.rick",
    packages: [
      {
        package: "selected@1",
        id: "selected",
        version: "1",
        checksum: "sha256:a",
        packageDir,
        reason: "target:research.rick",
      },
    ],
    exclusions: [{ package: "hidden@1", reason: "exclude:research.rick" }],
  });
  assert.equal(
    fs.existsSync(path.join(runRoot, "context", "skills", "selected", "SKILL.md")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(runRoot, "context", "skills", "hidden", "SKILL.md")),
    false
  );
  assert.equal(result.schema_version, 1);
  assert.equal(result.specialist_id, "research.rick");
  assert.deepEqual(result.packages[0].resolved.skills, [
    "context/skills/selected/SKILL.md",
  ]);
  assert.deepEqual(result.exclusions, [
    { package: "hidden@1", reason: "exclude:research.rick" },
  ]);
  const audit = JSON.parse(
    fs.readFileSync(path.join(runRoot, "EFFECTIVE_CAPABILITIES.json"), "utf8")
  );
  assert.deepEqual(audit, result);
});

test("all four provide types land in their typed destinations", () => {
  const bundle = writePackage({
    id: "bundle",
    provides: {
      skills: ["skills/one/SKILL.md"],
      plugins: ["plugins/demo"],
      mcps: ["mcps/server.json"],
      frameworks: ["frameworks/kit"],
    },
    files: {
      "skills/one/SKILL.md": "# One\n",
      "plugins/demo/plugin.json": "{}\n",
      "mcps/server.json": JSON.stringify({
        mcpServers: { demo: { command: "demo" } },
      }),
      "frameworks/kit/README.md": "# Kit\n",
    },
  });
  const runRoot = tmpdir("tu-run-");
  const result = materializeCapabilityCapsule({
    runRoot,
    specialistId: "testing.hannes",
    packages: [bundle],
  });
  assert.deepEqual(result.packages[0].resolved, {
    skills: ["context/skills/one/SKILL.md"],
    plugins: ["harness/plugins/demo"],
    mcps: ["harness/mcp/server.json"],
    frameworks: ["context/framework/kit"],
  });
  assert.equal(
    fs.existsSync(path.join(runRoot, "harness", "plugins", "demo", "plugin.json")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(runRoot, "context", "framework", "kit", "README.md")),
    true
  );
  assert.deepEqual(buildStrictMcpConfig(result, runRoot), {
    mcpServers: { demo: { command: "demo" } },
  });
});

test("paths outside a typed prefix are namespaced by capability id", () => {
  const loose = writePackage({
    id: "loose",
    provides: { skills: ["SKILL.md"] },
    files: { "SKILL.md": "# Loose\n" },
  });
  const runRoot = tmpdir("tu-run-");
  const result = materializeCapabilityCapsule({
    runRoot,
    specialistId: "testing.hannes",
    packages: [loose],
  });
  assert.deepEqual(result.packages[0].resolved.skills, [
    "context/skills/loose/SKILL.md",
  ]);
});

test("colliding capsule paths fail and leave no partial capsule", () => {
  const a = writePackage({
    id: "a",
    provides: { skills: ["skills/same/SKILL.md"] },
    files: { "skills/same/SKILL.md": "# A\n" },
  });
  const b = writePackage({
    id: "b",
    provides: { skills: ["skills/same/SKILL.md"] },
    files: { "skills/same/SKILL.md": "# B\n" },
  });
  const runRoot = tmpdir("tu-run-");
  assert.throws(
    () =>
      materializeCapabilityCapsule({
        runRoot,
        specialistId: "testing.hannes",
        packages: [a, b],
      }),
    /CAPSULE_PATH_COLLISION/
  );
  assert.equal(fs.existsSync(path.join(runRoot, "context")), false);
  assert.equal(fs.existsSync(path.join(runRoot, "harness")), false);
  assert.equal(
    fs.existsSync(path.join(runRoot, "EFFECTIVE_CAPABILITIES.json")),
    false
  );
});

test("colliding MCP server names fail closed", () => {
  const one = writePackage({
    id: "one",
    provides: { mcps: ["mcps/one.json"] },
    files: {
      "mcps/one.json": JSON.stringify({ mcpServers: { shared: { command: "a" } } }),
    },
  });
  const two = writePackage({
    id: "two",
    provides: { mcps: ["mcps/two.json"] },
    files: {
      "mcps/two.json": JSON.stringify({ mcpServers: { shared: { command: "b" } } }),
    },
  });
  const runRoot = tmpdir("tu-run-");
  const result = materializeCapabilityCapsule({
    runRoot,
    specialistId: "testing.hannes",
    packages: [one, two],
  });
  assert.throws(() => buildStrictMcpConfig(result, runRoot), /MCP_NAME_COLLISION/);
});

test("an unassigned pool package changes no capsule byte", () => {
  const selected = writePackage({
    id: "selected",
    provides: { skills: ["skills/sel/SKILL.md"] },
    files: { "skills/sel/SKILL.md": "# Selected\n" },
  });
  // The unselected package exists in the pool but is never passed to the
  // capsule; its description must not reach the worker in any form.
  writePackage({
    id: "unselected",
    provides: { skills: ["skills/uns/SKILL.md"] },
    files: {
      "skills/uns/SKILL.md": "# Unselected, a long description ".repeat(50),
    },
  });

  const before = tmpdir("tu-run-");
  const beforeRecord = materializeCapabilityCapsule({
    runRoot: before,
    specialistId: "testing.hannes",
    packages: [selected],
  });
  const after = tmpdir("tu-run-");
  const afterRecord = materializeCapabilityCapsule({
    runRoot: after,
    specialistId: "testing.hannes",
    packages: [selected],
  });

  assert.equal(
    treeSize(path.join(before, "context")),
    treeSize(path.join(after, "context"))
  );
  assert.equal(
    treeSize(path.join(before, "harness")),
    treeSize(path.join(after, "harness"))
  );
  assert.equal(
    beforeRecord.totals.estimated_description_tokens,
    afterRecord.totals.estimated_description_tokens
  );
  assert.equal(beforeRecord.totals.mcp_tool_count, afterRecord.totals.mcp_tool_count);
});

test("totals sum the per-package context cost", () => {
  const a = { ...writePackage({
    id: "a",
    provides: { skills: ["skills/a/SKILL.md"] },
    files: { "skills/a/SKILL.md": "# A\n" },
  }), estimated_description_tokens: 10, mcp_tool_count: 2 };
  const b = { ...writePackage({
    id: "b",
    provides: { skills: ["skills/b/SKILL.md"] },
    files: { "skills/b/SKILL.md": "# B\n" },
  }), estimated_description_tokens: 5, mcp_tool_count: 3 };
  const runRoot = tmpdir("tu-run-");
  const result = materializeCapabilityCapsule({
    runRoot,
    specialistId: "testing.hannes",
    packages: [a, b],
  });
  assert.deepEqual(result.totals, {
    estimated_description_tokens: 15,
    mcp_tool_count: 5,
  });
});
