import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { brokerToolName, listBrokerTools } from "../../src/commands/mcp-server.mjs";

const brokerBin = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../bin/team-up-command-broker.mjs"
);

test("one no-argument MCP tool per approved action", () => {
  const policy = {
    schema_version: 1,
    commands: {
      "project-test": {
        argv: ["npm", "test"],
        cwd: ".",
        timeout_seconds: 1800,
        environment: {},
      },
    },
  };
  assert.equal(brokerToolName("project-test"), "project_test");
  assert.deepEqual(listBrokerTools(policy).map((x) => x.name), ["project_test"]);
  assert.deepEqual(listBrokerTools(policy)[0].inputSchema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
});

test("stdio broker lists and runs only project_test", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-broker-proj-"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-broker-run-"));
  const policyDir = path.join(runDir, "policy");
  fs.mkdirSync(policyDir, { recursive: true });
  const policy = {
    schema_version: 1,
    commands: {
      "project-test": {
        argv: [process.execPath, "-e", "process.stdout.write('broker-ok')"],
        cwd: ".",
        timeout_seconds: 10,
        environment: {},
      },
    },
  };
  const policyPath = path.join(policyDir, "commands.json");
  fs.writeFileSync(policyPath, JSON.stringify(policy));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [brokerBin],
    env: {
      ...process.env,
      TEAM_UP_COMMAND_POLICY_SNAPSHOT: policyPath,
      TEAM_UP_PROJECT: project,
      TEAM_UP_RUN_DIR: runDir,
    },
  });
  const client = new Client({ name: "team-up-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((t) => t.name),
      ["project_test"]
    );
    const called = await client.callTool({ name: "project_test", arguments: {} });
    assert.equal(called.isError, undefined);
    const body = JSON.parse(called.content[0].text);
    assert.equal(body.exit_code, 0);
    assert.equal(body.stdout, "broker-ok");
    assert.equal(body.shell, false);
  } finally {
    await client.close();
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
