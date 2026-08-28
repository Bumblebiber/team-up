import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectCapsuleMcpTools } from "../../src/capabilities/capsule.mjs";

function withDescriptor(document, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-tools-"));
  try {
    fs.writeFileSync(path.join(root, "mcp.json"), JSON.stringify(document));
    return fn({ packages: [{ resolved: { mcps: ["mcp.json"] } }] }, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a shared tool list is not attributed across several servers", () => {
  const collected = withDescriptor(
    { tools: ["search"], mcpServers: { a: { command: "x" }, b: { command: "y" } } },
    collectCapsuleMcpTools
  );
  // Handing the list to both would grant each server the other's tool names.
  assert.deepEqual(collected.mcpToolNames, []);
});

test("a shared tool list is attributed when one server declares it", () => {
  const collected = withDescriptor(
    { tools: ["search", "fetch-page"], mcpServers: { a: { command: "x" } } },
    collectCapsuleMcpTools
  );
  // Hyphens are not legal in a tool name; the allowlist form uses underscores.
  assert.deepEqual(collected.mcpToolNames, ["mcp__a__search", "mcp__a__fetch_page"]);
});

test("a per-server tool list wins over the shared one", () => {
  const collected = withDescriptor(
    { tools: ["shared"], mcpServers: { a: { tools: ["own"] } } },
    collectCapsuleMcpTools
  );
  assert.deepEqual(collected.mcpToolNames, ["mcp__a__own"]);
  assert.deepEqual(collected.mcpToolsByServer, { a: ["own"] });
});
