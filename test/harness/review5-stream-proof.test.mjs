import test from "node:test";
import assert from "node:assert/strict";
import {
  parseClaudeStreamToolProof,
  extractStructuredInitInventory,
} from "../../src/harness/isolation-canary.mjs";

const SESSION = "sess-fixture-220";
const NONCE = "nonce-abc-123";
const TOOL = "mcp__selected__lookup";

function line(obj) {
  return JSON.stringify(obj);
}

function initEvent(overrides = {}) {
  return line({
    type: "system",
    subtype: "init",
    session_id: SESSION,
    tools: ["Read", "ToolSearch", TOOL],
    mcp_servers: [{ name: "selected", status: "connected" }],
    skills: ["capsule.selected-skill"],
    plugins: ["capsule.selected-plugin"],
    claude_code_version: "2.1.220",
    ...overrides,
  });
}

function toolUse(id = "tu-1", name = TOOL) {
  return line({
    type: "assistant",
    session_id: SESSION,
    message: {
      content: [{ type: "tool_use", id, name, input: {} }],
    },
  });
}

function toolResult(id = "tu-1", content = `team-up-canary-ok:${NONCE}`) {
  return line({
    type: "user",
    session_id: SESSION,
    message: {
      content: [{ type: "tool_result", tool_use_id: id, content }],
    },
  });
}

test("stream proof accepts real Claude 2.1.220 tool_use then matching tool_result", () => {
  const stream = [initEvent(), toolUse(), toolResult()].join("\n");
  const proof = parseClaudeStreamToolProof(stream, { toolName: TOOL, nonce: NONCE });
  assert.deepEqual(proof, {
    tool: TOOL,
    nonce: NONCE,
    tool_use_id: "tu-1",
    session_id: SESSION,
  });
});

test("stream proof rejects tool_result before tool_use", () => {
  const stream = [initEvent(), toolResult(), toolUse()].join("\n");
  assert.equal(
    parseClaudeStreamToolProof(stream, { toolName: TOOL, nonce: NONCE }),
    null
  );
});

test("stream proof rejects mismatched tool_use_id", () => {
  const stream = [initEvent(), toolUse("tu-1"), toolResult("tu-OTHER")].join("\n");
  assert.equal(
    parseClaudeStreamToolProof(stream, { toolName: TOOL, nonce: NONCE }),
    null
  );
});

test("stream proof rejects arbitrary top-level JSON without init session", () => {
  const stream = [
    line({ hello: "world", tools: [TOOL] }),
    toolUse(),
    toolResult(),
  ].join("\n");
  assert.equal(
    parseClaudeStreamToolProof(stream, { toolName: TOOL, nonce: NONCE }),
    null
  );
});

test("stream proof rejects stale/non-matching session_id", () => {
  const stream = [
    initEvent(),
    line({
      type: "assistant",
      session_id: "other-session",
      message: { content: [{ type: "tool_use", id: "tu-1", name: TOOL, input: {} }] },
    }),
    toolResult(),
  ].join("\n");
  assert.equal(
    parseClaudeStreamToolProof(stream, { toolName: TOOL, nonce: NONCE }),
    null
  );
});

test("stream proof rejects substring-only nonce match", () => {
  const stream = [
    initEvent(),
    toolUse(),
    toolResult("tu-1", `prefix-${NONCE}-suffix-without-exact-payload`),
  ].join("\n");
  assert.equal(
    parseClaudeStreamToolProof(stream, { toolName: TOOL, nonce: NONCE }),
    null
  );
});

test("stream proof rejects stderr-only text", () => {
  assert.equal(
    parseClaudeStreamToolProof(`error: ${NONCE}\n`, { toolName: TOOL, nonce: NONCE }),
    null
  );
});

test("stream proof rejects duplicate conflicting tool_use ids for same tool", () => {
  const stream = [
    initEvent(),
    toolUse("tu-1"),
    toolUse("tu-2"),
    toolResult("tu-1"),
  ].join("\n");
  assert.equal(
    parseClaudeStreamToolProof(stream, { toolName: TOOL, nonce: NONCE }),
    null
  );
});

test("structured init inventory derives tools/skills/plugins/mcp without model JSON", () => {
  const stream = initEvent({
    tools: ["Read", "ToolSearch", TOOL],
    mcp_servers: [{ name: "selected", status: "connected" }],
    skills: ["capsule.selected-skill"],
    plugins: ["capsule.selected-plugin"],
  });
  const inv = extractStructuredInitInventory(stream);
  assert.ok(inv);
  assert.ok(inv.tools.includes(TOOL));
  assert.ok(inv.mcp_servers.includes("selected"));
  assert.ok(inv.skills.includes("capsule.selected-skill"));
  assert.ok(inv.plugins.includes("capsule.selected-plugin"));
  assert.equal(inv.session_id, SESSION);
});
