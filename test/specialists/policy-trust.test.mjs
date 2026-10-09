import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.mjs";
import { isPolicyTrusted, trustProjectPolicy } from "../../src/specialists/approvals.mjs";
import { commandPolicyChecksum } from "../../src/commands/policy.mjs";

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

function writePolicy(project, value = policy) {
  const dir = path.join(project, ".team-up");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify(value));
}

test("project policy trust records checksum and project; changed policy needs a new trust action", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-policy-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-policy-project-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  try {
    writePolicy(project);
    const checksum = commandPolicyChecksum(policy);
    assert.equal(isPolicyTrusted({ checksum, env }), false);

    const trusted = trustProjectPolicy({ project, env });
    assert.equal(trusted.ok, true, trusted.errors?.join("; "));
    assert.equal(trusted.checksum, checksum);
    assert.equal(isPolicyTrusted({ checksum, env }), true);

    const changed = {
      ...policy,
      commands: {
        "project-test": { ...policy.commands["project-test"], timeout_seconds: 60 },
      },
    };
    writePolicy(project, changed);
    const changedChecksum = commandPolicyChecksum(changed);
    assert.notEqual(changedChecksum, checksum);
    assert.equal(isPolicyTrusted({ checksum: changedChecksum, env }), false);
    assert.equal(trustProjectPolicy({ project, env }).ok, true);
    assert.equal(isPolicyTrusted({ checksum: changedChecksum, env }), true);

    const data = JSON.parse(fs.readFileSync(path.join(home, "approvals.json"), "utf8"));
    assert.deepEqual(data.trusted_policies[changedChecksum], {
      project: fs.realpathSync(project),
      trusted_at: data.trusted_policies[changedChecksum].trusted_at,
    });
    assert.equal(data.approvals, undefined, "policy trust does not create specialist rows");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("trust-policy CLI requires an absolute project path and records trust", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-policy-cli-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-policy-cli-project-"));
  const prev = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    writePolicy(project);
    const errors = [];
    assert.equal(await runCli(["specialist", "trust-policy", "--project", "relative"], {
      out: () => {}, err: (line) => errors.push(line),
    }), 1);
    assert.match(errors.join("\n"), /absolute-path/);

    const output = [];
    assert.equal(await runCli(["specialist", "trust-policy", "--project", project], {
      out: (line) => output.push(line), err: (line) => output.push(line),
    }), 0, output.join("\n"));
    assert.equal(isPolicyTrusted({ checksum: commandPolicyChecksum(policy) }), true);
  } finally {
    if (prev === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
