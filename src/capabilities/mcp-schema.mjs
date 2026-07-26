import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync as realSpawnSync } from "node:child_process";

/**
 * Canonicalize a tools/list payload and return its UTF-8 byte length.
 * Configuration-file formatting must not affect this measurement.
 */
export function canonicalizeMcpToolSchema(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const normalized = list
    .map((tool) => ({
      name: String(tool?.name ?? ""),
      description: tool?.description == null ? undefined : String(tool.description),
      inputSchema: tool?.inputSchema ?? tool?.input_schema ?? undefined,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify(normalized);
}

export function mcpSchemaBytesFromToolsList(tools) {
  return Buffer.byteLength(canonicalizeMcpToolSchema(tools), "utf8");
}

/**
 * Speak MCP JSON-RPC tools/list against a configured stdio server.
 * Returns { tools, schema_bytes } or null when inspection fails.
 */
export function inspectMcpServerTools(server, { spawnSyncFn = realSpawnSync, timeoutMs = 15_000 } = {}) {
  if (!server?.command) return null;
  const args = Array.isArray(server.args) ? server.args : [];
  const env = { ...process.env, ...(server.env || {}) };
  const script = `
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(server.command)}, ${JSON.stringify(args)}, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: ${JSON.stringify(env)},
});
let buf = '';
const pending = new Map();
let nextId = 1;
function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error('timeout ' + method)), 8000);
  });
}
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});
(async () => {
  try {
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'team-up-schema', version: '1.0.0' },
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/initialized',
    }) + '\\n');
    const listed = await send('tools/list', {});
    process.stdout.write(JSON.stringify({ tools: listed.tools || [] }) + '\\n');
    child.kill('SIGTERM');
    process.exit(0);
  } catch (e) {
    process.stderr.write(String(e && e.message || e));
    child.kill('SIGTERM');
    process.exit(1);
  }
})();
`;
  const run = spawnSyncFn(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: timeoutMs,
    env,
  });
  if (run.error || run.status !== 0) return null;
  const line = String(run.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line);
    const tools = parsed.tools || [];
    return {
      tools,
      schema_bytes: mcpSchemaBytesFromToolsList(tools),
      measurement: "tools/list-canonical-json",
    };
  } catch {
    return null;
  }
}

export function estimatePromptTokenContribution(byteLength, {
  method = "utf8_bytes_div_4_ceil",
} = {}) {
  return {
    estimated_prompt_token_contribution: Math.ceil(byteLength / 4),
    prompt_token_estimate_method: method,
  };
}

export function randomContentNonce(bytes = 16) {
  return `tu-nonce-${crypto.randomBytes(bytes).toString("hex")}`;
}
