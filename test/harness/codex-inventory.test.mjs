import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodexResponsesToolInventory } from "../../src/harness/codex-inventory.mjs";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/harness"
);

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8"));
}

test("parseCodexResponsesToolInventory reads top-level tool names", () => {
  const body = loadFixture("codex-inventory-shell-disabled.json");
  const names = parseCodexResponsesToolInventory(body);
  assert.deepEqual(names.sort(), ["apply_patch", "read_file"]);
  assert.ok(!names.includes("exec_command"));
});

test("parseCodexResponsesToolInventory reads code-mode exec headings, not description substring", () => {
  const body = loadFixture("codex-inventory-code-mode-shell.json");
  const names = parseCodexResponsesToolInventory(body);
  assert.deepEqual(names.sort(), ["apply_patch", "exec", "read_file"]);
  assert.ok(!names.includes("exec_command"));
});

test("parseCodexResponsesToolInventory includes exec_command when present", () => {
  const body = loadFixture("codex-inventory-with-exec-command.json");
  const names = parseCodexResponsesToolInventory(body);
  assert.ok(names.includes("exec_command"));
  assert.ok(names.includes("write_stdin"));
});
