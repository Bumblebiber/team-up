import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackage } from "../../src/specialists/store.mjs";
import { approveSpecialist, isApproved } from "../../src/specialists/approvals.mjs";
import { resolveCommandPolicyForApproval } from "../../src/commands/policy.mjs";

/**
 * A global grant drops the path and keeps everything else: the package
 * checksum, the permissions, and — for a specialist that runs commands — a
 * project command policy whose checksum was trusted.
 */
const policy = {
  schema_version: 1,
  commands: { "project-test": { argv: ["npm", "test"], cwd: ".", timeout_seconds: 1800, environment: {} } },
};

const manifest = {
  schema_version: 1,
  id: "coding.globy",
  display_name: "Globy",
  version: "0.1.0",
  remit: ["x"],
  anti_remit: ["y"],
  call_types: ["consult"],
  accepted_inputs: ["task_description"],
  output_contract: "team-up.result/v1",
  capabilities: { skills: [], tools: ["command.test"], mcps: [], frameworks: [] },
  permissions: { filesystem: "project", writes: true, network: false, commands: ["project-test"] },
  budget: { timeout_seconds: 60 },
  model_profile: { tier: "medium", reasoning: "low" },
  eval_suite: "evals/evals.json",
};

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function project(body = policy) {
  const dir = tmp("tu-global-proj-");
  fs.mkdirSync(path.join(dir, ".team-up"));
  fs.writeFileSync(path.join(dir, ".team-up", "commands.json"), JSON.stringify(body));
  return dir;
}

async function fixture() {
  const home = tmp("tu-global-home-");
  const pkg = tmp("tu-global-pkg-");
  const env = { ...process.env, TEAM_UP_HOME: home, TEAM_UP_RUNS: path.join(home, "runs") };
  fs.writeFileSync(path.join(pkg, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(pkg, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(pkg, "evals"));
  fs.writeFileSync(path.join(pkg, "evals", "evals.json"), "[]");
  assert.equal((await installPackage(pkg, env)).ok, true);
  const index = JSON.parse(fs.readFileSync(path.join(home, "specialists-index.json"), "utf8"));
  const checksum = Object.values(index.specialists ?? index)[0].checksum;
  return { env, checksum };
}

/** What a launch in `dir` would ask. */
function launch(f, dir, over = {}) {
  const permissions = over.permissions ?? manifest.permissions;
  const { checksum: command_policy_checksum } = resolveCommandPolicyForApproval({ project: dir, permissions });
  return isApproved({
    project: dir,
    id: "coding.globy",
    version: over.version ?? "0.1.0",
    checksum: over.checksum ?? f.checksum,
    permissions,
    command_policy_checksum,
    env: f.env,
  });
}

test("a global grant covers an unrelated project with the same trusted policy", async () => {
  const f = await fixture();
  const a = project();
  const ap = await approveSpecialist({ idAtVersion: "coding.globy@0.1.0", project: a, global: true, env: f.env });
  assert.equal(ap.ok, true, ap.errors?.join("; "));
  assert.equal(ap.approval.scope, "global");
  assert.equal(ap.approval.project, undefined);
  assert.equal(launch(f, a), true);
  assert.equal(launch(f, project()), true, "another project carrying the same policy");
});

test("a global grant still binds version, checksum, permissions and the policy", async () => {
  const f = await fixture();
  const a = project();
  await approveSpecialist({ idAtVersion: "coding.globy@0.1.0", project: a, global: true, env: f.env });
  assert.equal(launch(f, a, { version: "0.2.0" }), false);
  assert.equal(launch(f, a, { checksum: "0".repeat(64) }), false);
  assert.equal(launch(f, a, { permissions: { ...manifest.permissions, network: true } }), false);
  // A checkout whose commands.json was edited carries an untrusted checksum.
  const edited = project({
    ...policy,
    commands: { "project-test": { ...policy.commands["project-test"], argv: ["npm", "run", "anything-else"] } },
  });
  assert.equal(launch(f, edited), false);
  // Approving there trusts that policy too.
  await approveSpecialist({ idAtVersion: "coding.globy@0.1.0", project: edited, global: true, env: f.env });
  assert.equal(launch(f, edited), true);
});

test("a global grant without a project covers specialists that run no commands", async () => {
  const f = await fixture();
  const ap = await approveSpecialist({ idAtVersion: "coding.globy@0.1.0", global: true, env: f.env });
  assert.equal(ap.ok, true);
  // This one declares a command, and no policy was trusted yet.
  assert.equal(launch(f, project()), false);
  const noCommands = { ...manifest.permissions, commands: [] };
  assert.equal(isApproved({
    project: tmp("tu-global-any-"), id: "coding.globy", version: "0.1.0", checksum: f.checksum,
    permissions: noCommands, command_policy_checksum: null, env: f.env,
  }), false, "different permissions are a different grant");
  assert.equal(isApproved({
    project: tmp("tu-global-any-"), id: "coding.globy", version: "0.1.0", checksum: f.checksum,
    permissions: manifest.permissions, command_policy_checksum: null, env: f.env,
  }), true);
});

test("approveSpecialist without project or global is refused", async () => {
  const f = await fixture();
  const ap = await approveSpecialist({ idAtVersion: "coding.globy@0.1.0", env: f.env });
  assert.equal(ap.ok, false);
});
