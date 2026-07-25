import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackage } from "../../src/specialists/store.mjs";
import { approveSpecialist, isApproved } from "../../src/specialists/approvals.mjs";
import {
  commandPolicyChecksum,
  validateCommandPolicy,
} from "../../src/commands/policy.mjs";

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

function writePkg(dir, manifest) {
  fs.writeFileSync(path.join(dir, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evals", "evals.json"), "[]");
}

function writeCommands(project, body = policy) {
  const dir = path.join(project, ".team-up");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify(body));
}

test("approval binds command_policy_checksum; changed policy is NOT_APPROVED", async () => {
  assert.equal(validateCommandPolicy(policy).ok, true);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-cap-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-cap-proj-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-cap-pkg-"));
  const env = {
    ...process.env,
    TEAM_UP_HOME: home,
    TEAM_UP_RUNS: path.join(home, "runs"),
  };
  writeCommands(project);
  writePkg(pkg, {
    schema_version: 1,
    id: "testing.cmdpol",
    display_name: "CmdPol",
    version: "0.1.0",
    remit: ["x"],
    anti_remit: ["y"],
    call_types: ["consult"],
    accepted_inputs: ["task_description"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: ["command.test"], mcps: [], frameworks: [] },
    permissions: {
      filesystem: "project_readonly",
      writes: false,
      network: false,
      commands: ["project-test"],
    },
    budget: { timeout_seconds: 60 },
    model_profile: { tier: "medium", reasoning: "low" },
    eval_suite: "evals/evals.json",
  });
  assert.equal((await installPackage(pkg, env)).ok, true);
  const ap = await approveSpecialist({
    idAtVersion: "testing.cmdpol@0.1.0",
    project,
    env,
  });
  assert.equal(ap.ok, true, ap.errors?.join("; "));
  const checksum = commandPolicyChecksum(policy);
  assert.equal(ap.approval.command_policy_checksum, checksum);
  assert.equal(
    isApproved({
      project,
      id: "testing.cmdpol",
      version: "0.1.0",
      checksum: ap.approval.checksum,
      permissions: ap.approval.permissions,
      command_policy_checksum: checksum,
      env,
    }),
    true
  );
  const changed = {
    ...policy,
    commands: {
      "project-test": {
        ...policy.commands["project-test"],
        timeout_seconds: 60,
      },
    },
  };
  const changedChecksum = commandPolicyChecksum(changed);
  assert.equal(
    isApproved({
      project,
      id: "testing.cmdpol",
      version: "0.1.0",
      checksum: ap.approval.checksum,
      permissions: ap.approval.permissions,
      command_policy_checksum: changedChecksum,
      env,
    }),
    false
  );
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(pkg, { recursive: true, force: true });
});
