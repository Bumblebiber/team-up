import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    specialistId: "research.reanna",
    packages: [{
      package: "selected@1", id: "selected", version: "1",
      checksum: "sha256:a", packageDir, reason: "target:research.reanna",
    }],
    exclusions: [{ package: "hidden@1", reason: "exclude:research.reanna" }],
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
    specialistId: "research.reanna",
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
    mcpServers: { s: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(0)"] } },
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
    runRoot: firstRoot, specialistId: "research.reanna", packages,
  });
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-"));
  const second = materializeCapabilityCapsule({
    runRoot: secondRoot, specialistId: "research.reanna", packages,
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

test("EFFECTIVE_CAPABILITIES records estimated_prompt_token_contribution and mcp_schema_bytes", () => {
  const canaryServer = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../src/harness/canary-mcp-server.mjs"
  );
  const selected = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
  const skillBody = "# Selected skill with measurable prompt weight\n";
  fs.mkdirSync(path.join(selected, "skills", "s"), { recursive: true });
  fs.writeFileSync(path.join(selected, "skills", "s", "SKILL.md"), skillBody);
  const mcpDocCompact = {
    mcpServers: {
      selected: {
        type: "stdio",
        command: process.execPath,
        args: [canaryServer],
        env: { TEAM_UP_CANARY_TOOL: "lookup", TEAM_UP_CANARY_RESULT: "ok" },
      },
    },
    tools: ["lookup"],
  };
  const mcpBodyCompact = `${JSON.stringify(mcpDocCompact)}\n`;
  const mcpBodyPretty = `${JSON.stringify(mcpDocCompact, null, 2)}\n`;
  assert.notEqual(Buffer.byteLength(mcpBodyCompact), Buffer.byteLength(mcpBodyPretty));
  fs.writeFileSync(path.join(selected, "mcp.json"), mcpBodyPretty);
  fs.writeFileSync(path.join(selected, "capability.json"), JSON.stringify({
    schema_version: 1, id: "sel", version: "1", display_name: "Sel",
    provides: { skills: ["skills/s/SKILL.md"], mcps: ["mcp.json"] },
    permissions: { network: false, commands: [] },
  }));

  const inert = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
  fs.mkdirSync(path.join(inert, "skills", "inert"), { recursive: true });
  fs.writeFileSync(path.join(inert, "skills", "inert", "SKILL.md"), "# INERT HUGE ".repeat(200));
  fs.writeFileSync(path.join(inert, "mcp-inert.json"), JSON.stringify({
    mcpServers: {
      inert: {
        type: "stdio",
        command: process.execPath,
        args: [canaryServer],
        env: { TEAM_UP_CANARY_TOOL: "noop", TEAM_UP_CANARY_RESULT: "ok" },
      },
    },
    tools: ["noop"],
  }));
  fs.writeFileSync(path.join(inert, "capability.json"), JSON.stringify({
    schema_version: 1, id: "inert", version: "1", display_name: "Inert",
    provides: {
      skills: ["skills/inert/SKILL.md"],
      mcps: ["mcp-inert.json"],
    },
    permissions: { network: false, commands: [] },
  }));

  const packages = [{
    package: "sel@1", id: "sel", version: "1", checksum: "sha256:s",
    packageDir: selected, reason: "target:all",
  }];
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-"));
  const first = materializeCapabilityCapsule({
    runRoot: firstRoot, specialistId: "research.reanna", packages,
  });
  assert.ok(first.packages[0].estimated_prompt_token_contribution > 0);
  assert.ok(first.packages[0].mcp_schema_bytes > 0);
  assert.equal(first.prompt_token_estimate_method, "utf8_bytes_div_4_ceil");
  assert.equal(first.packages[0].mcp_schema_measurement, "tools/list-canonical-json");
  assert.equal(
    first.totals.estimated_prompt_token_contribution,
    first.packages[0].estimated_prompt_token_contribution
  );
  assert.equal(first.totals.mcp_schema_bytes, first.packages[0].mcp_schema_bytes);
  assert.equal(
    first.packages[0].estimated_prompt_token_contribution,
    Math.ceil(Buffer.byteLength(skillBody) / 4)
  );
  assert.equal(Object.hasOwn(first.packages[0], "prompt_token_contribution"), false);
  assert.equal(Object.hasOwn(first.totals, "prompt_token_contribution"), false);
  // Must NOT equal config-file bytes (pretty vs compact would differ).
  assert.notEqual(first.packages[0].mcp_schema_bytes, Buffer.byteLength(mcpBodyPretty));
  assert.notEqual(first.packages[0].mcp_schema_bytes, Buffer.byteLength(mcpBodyCompact));

  // Canonical-format invariance: compact config yields same schema bytes.
  fs.writeFileSync(path.join(selected, "mcp.json"), mcpBodyCompact);
  const compactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-"));
  const compact = materializeCapabilityCapsule({
    runRoot: compactRoot, specialistId: "research.reanna", packages,
  });
  assert.equal(compact.packages[0].mcp_schema_bytes, first.packages[0].mcp_schema_bytes);

  // Inert (unselected) pool package must not change either metric.
  const still = materializeCapabilityCapsule({
    runRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-")),
    specialistId: "research.reanna",
    packages,
  });
  assert.equal(
    still.totals.estimated_prompt_token_contribution,
    first.totals.estimated_prompt_token_contribution
  );
  assert.equal(still.totals.mcp_schema_bytes, first.totals.mcp_schema_bytes);
  void inert;

  // Exclusion removes both contributions on the next capsule.
  const both = [
    ...packages,
    {
      package: "extra@1", id: "extra", version: "1", checksum: "sha256:e",
      packageDir: (() => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
        fs.mkdirSync(path.join(d, "skills", "extra"), { recursive: true });
        fs.writeFileSync(path.join(d, "skills", "extra", "SKILL.md"), "# EXTRA WEIGHT\n");
        fs.writeFileSync(path.join(d, "mcp.json"), JSON.stringify({
          mcpServers: {
            extra: {
              type: "stdio",
              command: process.execPath,
              args: [canaryServer],
              env: { TEAM_UP_CANARY_TOOL: "x", TEAM_UP_CANARY_RESULT: "ok" },
            },
          },
          tools: ["x"],
        }));
        fs.writeFileSync(path.join(d, "capability.json"), JSON.stringify({
          schema_version: 1, id: "extra", version: "1", display_name: "Extra",
          provides: { skills: ["skills/extra/SKILL.md"], mcps: ["mcp.json"] },
          permissions: { network: false, commands: [] },
        }));
        return d;
      })(),
      reason: "target:all",
    },
  ];
  const withExtra = materializeCapabilityCapsule({
    runRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-")),
    specialistId: "research.reanna",
    packages: both,
  });
  assert.ok(
    withExtra.totals.estimated_prompt_token_contribution >
      first.totals.estimated_prompt_token_contribution
  );
  assert.ok(withExtra.totals.mcp_schema_bytes > first.totals.mcp_schema_bytes);

  const excluded = materializeCapabilityCapsule({
    runRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-")),
    specialistId: "research.reanna",
    packages,
    exclusions: [{ package: "extra@1", reason: "exclude:research.reanna" }],
  });
  assert.equal(
    excluded.totals.estimated_prompt_token_contribution,
    first.totals.estimated_prompt_token_contribution
  );
  assert.equal(excluded.totals.mcp_schema_bytes, first.totals.mcp_schema_bytes);
});
