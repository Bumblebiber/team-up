import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.mjs";
import { resolveInstalled } from "../../src/specialists/store.mjs";

function writePackage(dir, version) {
  fs.writeFileSync(path.join(dir, "specialist.json"), JSON.stringify({
    schema_version: 1,
    id: "testing.installselect",
    display_name: "InstallSelect",
    version,
    remit: ["x"],
    anti_remit: ["y"],
    call_types: ["consult"],
    accepted_inputs: ["task_description"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
    permissions: { filesystem: "project_readonly", writes: false, network: false, commands: [] },
    budget: { timeout_seconds: 60 },
    eval_suite: "evals/evals.json",
  }));
  fs.writeFileSync(path.join(dir, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evals", "evals.json"), "[]");
}

test("install selects installed version without creating specialist trust rows", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-install-select-home-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-install-select-pkg-"));
  const prev = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    writePackage(pkg, "0.1.0");
    const output = [];
    assert.equal(await runCli(["specialist", "install", pkg], {
      out: (line) => output.push(line), err: (line) => output.push(line),
    }), 0, output.join("\n"));
    const installed = JSON.parse(output.join("\n"));
    assert.equal(installed.version, "0.1.0");
    assert.equal(resolveInstalled("testing.installselect").version, "0.1.0");
    assert.equal(fs.existsSync(path.join(home, "approvals.json")), false);
  } finally {
    if (prev === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});
