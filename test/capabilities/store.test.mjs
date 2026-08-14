import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  importLocalCapability,
  inspectCapabilitySource,
  inspectInstalledCapability,
  listInstalledCapabilities,
} from "../../src/capabilities/store.mjs";

function tmpdir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function fixture(overrides = {}) {
  const root = tmpdir("team-up-source-");
  fs.mkdirSync(path.join(root, "skills", "short"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "short", "SKILL.md"), "# Short\n");
  fs.writeFileSync(
    path.join(root, "capability.json"),
    JSON.stringify({
      schema_version: 1,
      id: "example.short",
      version: "1.0.0",
      display_name: "Short",
      provides: { skills: ["skills/short/SKILL.md"] },
      permissions: { network: false, commands: [] },
      ...overrides,
    })
  );
  return root;
}

test("identical local imports collapse to one checksum path", () => {
  const home = tmpdir("team-up-home-");
  const env = { TEAM_UP_HOME: home };
  const first = importLocalCapability(fixture(), { env });
  const second = importLocalCapability(fixture(), { env });
  assert.equal(first.checksum, second.checksum);
  assert.equal(first.packageDir, second.packageDir);
  assert.equal(listInstalledCapabilities({ env }).length, 1);
  assert.equal(
    inspectInstalledCapability("example.short@1.0.0", {
      checksum: first.checksum,
      env,
    }).checksum,
    first.checksum
  );
});

test("differing contents produce different checksums and coexist", () => {
  const home = tmpdir("team-up-home-");
  const env = { TEAM_UP_HOME: home };
  const first = importLocalCapability(fixture(), { env });
  const changed = fixture();
  fs.writeFileSync(
    path.join(changed, "skills", "short", "SKILL.md"),
    "# Short but different\n"
  );
  const second = importLocalCapability(changed, { env });
  assert.notEqual(first.checksum, second.checksum);
  assert.equal(listInstalledCapabilities({ env }).length, 2);
  assert.throws(
    () => inspectInstalledCapability("example.short@1.0.0", { env }),
    /exactly once/
  );
});

test("imported package copies only declared files plus the manifest", () => {
  const home = tmpdir("team-up-home-");
  const env = { TEAM_UP_HOME: home };
  const source = fixture();
  fs.writeFileSync(path.join(source, "UNDECLARED.md"), "secret\n");
  const record = importLocalCapability(source, { env });
  assert.deepEqual(fs.readdirSync(record.packageDir).sort(), [
    "capability.json",
    "skills",
  ]);
  assert.equal(record.source.type, "local");
  assert.ok(record.imported_at);
  assert.ok(record.estimated_description_tokens > 0);
  assert.equal(record.mcp_tool_count, 0);
});

test("mcp tool counts feed the context estimate", () => {
  const home = tmpdir("team-up-home-");
  const env = { TEAM_UP_HOME: home };
  const source = tmpdir("team-up-source-");
  fs.mkdirSync(path.join(source, "mcp"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "mcp", "server.json"),
    JSON.stringify({ tools: [{ name: "a" }, { name: "b" }] })
  );
  fs.writeFileSync(
    path.join(source, "capability.json"),
    JSON.stringify({
      schema_version: 1,
      id: "example.mcp",
      version: "0.1.0",
      display_name: "MCP",
      provides: { mcps: ["mcp/server.json"] },
    })
  );
  const record = importLocalCapability(source, { env });
  assert.equal(record.mcp_tool_count, 2);
});

test("invalid import leaves neither destination nor index entry", () => {
  const home = tmpdir("team-up-home-");
  const source = fixture();
  fs.rmSync(path.join(source, "skills", "short", "SKILL.md"));
  assert.throws(
    () => importLocalCapability(source, { env: { TEAM_UP_HOME: home } }),
    /missing/
  );
  assert.equal(
    fs.existsSync(path.join(home, "capability-pool", "index.json")),
    false
  );
  const poolRoot = path.join(home, "capability-pool");
  if (fs.existsSync(poolRoot)) {
    const stray = fs
      .readdirSync(poolRoot, { recursive: true })
      .filter((entry) => String(entry).includes(".import-"));
    assert.deepEqual(stray, []);
  }
});

test("inspecting a source never writes to the pool", () => {
  const home = tmpdir("team-up-home-");
  const env = { TEAM_UP_HOME: home };
  const preview = inspectCapabilitySource(fixture());
  assert.match(preview.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(preview.files, ["skills/short/SKILL.md"]);
  assert.equal(fs.existsSync(path.join(home, "capability-pool")), false);
  assert.deepEqual(listInstalledCapabilities({ env }), []);
});
