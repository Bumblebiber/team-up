#!/usr/bin/env node
/**
 * Minimal stdio MCP server for isolation canaries.
 * Speaks just enough JSON-RPC for tools/list + tools/call.
 */
import readline from "node:readline";

const TOOL_NAME = process.env.TEAM_UP_CANARY_TOOL || "lookup";
const TOOL_RESULT = process.env.TEAM_UP_CANARY_RESULT || "team-up-canary-ok";

const tools = [
  {
    name: TOOL_NAME,
    description: "team-up isolation canary tool",
    inputSchema: { type: "object", properties: {} },
  },
];

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "team-up-canary-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return;
  }
  if (method === "tools/list") {
    write({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (name !== TOOL_NAME) {
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `unknown tool: ${name}` },
      });
      return;
    }
    write({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: TOOL_RESULT }],
        isError: false,
      },
    });
    return;
  }
  if (id != null) {
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = String(line || "").trim();
  if (!trimmed) return;
  try {
    handle(JSON.parse(trimmed));
  } catch {
    // ignore malformed
  }
});
