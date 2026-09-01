import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogue = JSON.parse(fs.readFileSync(path.join(ROOT, "catalogue.json"), "utf8"));

test("every catalogue entry carries what a reader needs to decide", () => {
  assert.equal(catalogue.schema_version, 1);
  assert.ok(catalogue.specialists.length > 0);
  const seen = new Set();
  for (const s of catalogue.specialists) {
    assert.match(s.id, /^[a-z0-9]+\.[a-z0-9]+$/, `${s.id}: id shape`);
    assert.equal(seen.has(s.id), false, `${s.id}: listed twice`);
    seen.add(s.id);
    assert.match(s.version, /^\d+\.\d+\.\d+$/, `${s.id}: version`);
    assert.match(s.repo, /^https:\/\/github\.com\//, `${s.id}: repo`);
    assert.ok(s.summary?.length > 20, `${s.id}: summary`);
    assert.ok(Array.isArray(s.call_types) && s.call_types.length, `${s.id}: call_types`);
    // Permissions are the reason to read a catalogue at all — a reader deciding
    // whether to run a stranger's specialist needs them before the repo URL.
    for (const key of ["filesystem", "writes", "network", "commands"]) {
      assert.ok(key in s.permissions, `${s.id}: permissions.${key} missing`);
    }
    assert.ok("caveat" in s, `${s.id}: caveat must be stated or explicitly null`);
  }
});

test("a network-granting entry says so, and none claims an unknown scope", () => {
  const scopes = new Set(["none", "project_readonly", "project", "home"]);
  for (const s of catalogue.specialists) {
    assert.ok(scopes.has(s.permissions.filesystem), `${s.id}: unknown filesystem scope`);
    assert.equal(typeof s.permissions.network, "boolean", `${s.id}: network`);
  }
});

test("catalogued capabilities match the packages in this repo", () => {
  // The list is hand-maintained, so the half that lives here is checked against
  // the manifests. It already caught one: style.caveman listed as 0.1.0.
  for (const c of catalogue.capabilities) {
    const manifestPath = path.join(ROOT, c.source, "capability.json");
    assert.ok(fs.existsSync(manifestPath), `${c.id}: ${c.source} has no capability.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.id, c.id, `${c.id}: id disagrees with its manifest`);
    assert.equal(manifest.version, c.version, `${c.id}: version disagrees with its manifest`);
  }
});

test("every capability package in the repo is catalogued", () => {
  const listed = new Set(catalogue.capabilities.map((c) => c.id));
  const onDisk = fs
    .readdirSync(path.join(ROOT, "capabilities"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => fs.existsSync(path.join(ROOT, "capabilities", e.name, "capability.json")))
    .map((e) => e.name);
  for (const id of onDisk) {
    assert.ok(listed.has(id), `${id} exists but is not in the catalogue`);
  }
});
