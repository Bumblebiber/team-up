// Every specialist works in every project: installing one is the trust
// decision, so install writes the global grant itself. --no-approve keeps the
// old two-step for anyone who wants it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.mjs";
import { isApproved } from "../../src/specialists/approvals.mjs";

const permissions = { filesystem: "project_readonly", writes: false, network: false, commands: [] };

function writePkg(dir) {
  fs.writeFileSync(path.join(dir, "specialist.json"), JSON.stringify({
    schema_version: 1,
    id: "testing.autogrant",
    display_name: "AutoGrant",
    version: "0.1.0",
    remit: ["x"],
    anti_remit: ["y"],
    call_types: ["consult"],
    accepted_inputs: ["task_description"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
    permissions,
    budget: { timeout_seconds: 60, max_tokens: 1000 },
    eval_suite: "evals/evals.json",
  }));
  fs.writeFileSync(path.join(dir, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evals", "evals.json"), "[]");
}

async function installIn(extraArgs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-autogrant-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
  const prev = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    writePkg(pkg);
    const out = [];
    const code = await runCli(["specialist", "install", pkg, ...extraArgs], { out: (l) => out.push(l), err: (l) => out.push(l) });
    assert.equal(code, 0, out.join("\n"));
    const { checksum } = JSON.parse(out.join("\n"));
    return isApproved({
      project: fs.mkdtempSync(path.join(os.tmpdir(), "tu-anyproject-")),
      id: "testing.autogrant",
      version: "0.1.0",
      checksum,
      permissions,
      env: { ...process.env },
    });
  } finally {
    if (prev === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pkg, { recursive: true, force: true });
  }
}

test("install approves the specialist for every project", async () => {
  assert.equal(await installIn([]), true);
});

test("install --no-approve leaves the specialist unapproved", async () => {
  assert.equal(await installIn(["--no-approve"]), false);
});
