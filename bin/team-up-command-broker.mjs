#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { startBrokerStdio } from "../src/commands/mcp-server.mjs";

function requireEnvPath(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required env ${name}`);
    process.exit(2);
  }
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    console.error(`invalid ${name}: ${resolved}`);
    process.exit(2);
  }
  return resolved;
}

const policyPath = requireEnvPath("TEAM_UP_COMMAND_POLICY_SNAPSHOT");
const project = requireEnvPath("TEAM_UP_PROJECT");
const runDir = requireEnvPath("TEAM_UP_RUN_DIR");

await startBrokerStdio({ policyPath, project, runDir });
