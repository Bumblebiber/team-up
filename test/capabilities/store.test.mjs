import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  importLocalCapability,
  inspectInstalledCapability,
  listInstalledCapabilities,
} from "../../src/capabilities/store.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-source-"));
  fs.mkdirSync(path.join(root, "skills", "short"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "short", "SKILL.md"), "# Short\n");
  fs.writeFileSync(path.join(root, "capability.json"), JSON.stringify({
    schema_version: 1,
    id: "example.short",
    version: "1.0.0",
    display_name: "Short",
    provides: { skills: ["skills/short/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }));
  return root;
}

test("identical local imports collapse to one checksum path", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-home-"));
  const env = { TEAM_UP_HOME: home };
  const first = importLocalCapability(fixture(), { env });
  const second = importLocalCapability(fixture(), { env });
  assert.equal(first.checksum, second.checksum);
  assert.equal(first.packageDir, second.packageDir);
  assert.equal(listInstalledCapabilities({ env }).length, 1);
  assert.equal(inspectInstalledCapability("example.short@1.0.0", {
    checksum: first.checksum, env,
  }).checksum, first.checksum);
});

test("invalid import leaves neither destination nor index entry", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-home-"));
  const source = fixture();
  fs.rmSync(path.join(source, "skills", "short", "SKILL.md"));
  assert.throws(() => importLocalCapability(source, {
    env: { TEAM_UP_HOME: home },
  }), /missing/);
  assert.equal(fs.existsSync(path.join(home, "capability-pool", "index.json")), false);
});
