import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeApprovedAction } from "./execute.mjs";
import { validateCommandPolicy } from "./policy.mjs";

/** Map action id `project-test` → MCP tool name `project_test`. */
export function brokerToolName(actionId) {
  return String(actionId).replace(/-/g, "_");
}

export function listBrokerTools(policy) {
  const result = validateCommandPolicy(policy);
  if (!result.ok) {
    const err = new Error(`COMMAND_POLICY_INVALID: ${result.errors.join("; ")}`);
    err.code = "COMMAND_POLICY_INVALID";
    throw err;
  }
  return Object.keys(policy.commands).map((actionId) => ({
    name: brokerToolName(actionId),
    actionId,
    description: `Run approved project action ${actionId} (fixed argv; no arguments)`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }));
}

function loadSnapshotPolicy(policyPath) {
  const abs = path.resolve(policyPath);
  if (!fs.existsSync(abs)) {
    const err = new Error(`COMMAND_POLICY_MISSING: ${abs}`);
    err.code = "COMMAND_POLICY_MISSING";
    throw err;
  }
  const policy = JSON.parse(fs.readFileSync(abs, "utf8"));
  const result = validateCommandPolicy(policy);
  if (!result.ok) {
    const err = new Error(`COMMAND_POLICY_INVALID: ${result.errors.join("; ")}`);
    err.code = "COMMAND_POLICY_INVALID";
    throw err;
  }
  return { policy, path: abs };
}

/**
 * Create an MCP server exposing one no-argument tool per approved action.
 */
export function createBrokerServer({ policyPath, project, runDir }) {
  const { policy } = loadSnapshotPolicy(policyPath);
  const tools = listBrokerTools(policy);
  const server = new McpServer({
    name: "team-up-command-broker",
    version: "1.0.0",
  });

  const emptySchema = z.object({}).strict();

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: emptySchema,
      },
      async (args = {}) => {
        if (args && typeof args === "object" && Object.keys(args).length > 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `ACTION_DENIED: tool ${tool.name} accepts no arguments`,
              },
            ],
          };
        }
        try {
          const result = await executeApprovedAction({
            actionId: tool.actionId,
            policy,
            project,
            runDir,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action_id: result.action_id,
                  exit_code: result.exit_code,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  stdout_truncated: result.stdout_truncated,
                  stderr_truncated: result.stderr_truncated,
                  shell: false,
                }),
              },
            ],
          };
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text", text: String(e.message || e) }],
          };
        }
      }
    );
  }

  return { server, tools, policy };
}

export async function startBrokerStdio({ policyPath, project, runDir }) {
  const { server } = createBrokerServer({ policyPath, project, runDir });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

export function brokerBinPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/team-up-command-broker.mjs");
}
