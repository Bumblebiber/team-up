import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.mjs";
import { installPackage } from "../../src/specialists/store.mjs";

function capture() {
  const out = [], err = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

test("install is inert until explicit enable and list is JSON", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-"));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "tu-cap-"));
  fs.mkdirSync(path.join(source, "skills", "x"), { recursive: true });
  fs.writeFileSync(path.join(source, "skills", "x", "SKILL.md"), "# X\n");
  fs.writeFileSync(path.join(source, "capability.json"), JSON.stringify({
    schema_version: 1, id: "x", version: "1", display_name: "X",
    provides: { skills: ["skills/x/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }));
  const prior = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    const c = capture();
    assert.equal(await runCli(["capability", "install", source], c.io), 0);
    assert.equal(await runCli(["capability", "list"], c.io), 0);
    assert.match(c.out.at(-1), /"assignments": \[\]/);
    assert.equal(await runCli([
      "capability", "enable", "x@1", "--checksum",
      JSON.parse(c.out[0]).checksum, "--for", "all",
    ], c.io), 0);
  } finally {
    if (prior === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prior;
  }
});

test("recommendations command does not mutate pool or assignments", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-spec-"));
  const manifest = {
    schema_version: 1,
    id: "testing.rec",
    display_name: "Rec",
    version: "0.1.0",
    remit: ["x"],
    anti_remit: ["y"],
    call_types: ["consult", "delegate", "review"],
    accepted_inputs: ["task_description"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
    permissions: { filesystem: "project_readonly", writes: false, network: false, commands: [] },
    budget: { timeout_seconds: 60, max_tokens: 1000 },
    model_profile: { tier: "medium", reasoning: "low" },
    eval_suite: "evals/evals.json",
    recommendations: [{
      package: "o9k.caveman",
      source: "https://github.com/example/caveman.git",
      reason: "shorten",
    }],
  };
  fs.writeFileSync(path.join(pkg, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(pkg, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(pkg, "evals"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "evals", "evals.json"), "[]");
  const prior = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    assert.equal((await installPackage(pkg, { TEAM_UP_HOME: home })).ok, true);
    const before = capture();
    assert.equal(await runCli(["capability", "list"], before.io), 0);
    const beforeJson = before.out.at(-1);
    const rec = capture();
    assert.equal(await runCli(["capability", "recommendations", "testing.rec"], rec.io), 0);
    assert.match(rec.out.at(-1), /"selected": false/);
    const after = capture();
    assert.equal(await runCli(["capability", "list"], after.io), 0);
    assert.equal(after.out.at(-1), beforeJson);
  } finally {
    if (prior === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prior;
  }
});

test("enable refuses a checksum that is not installed", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-"));
  const prior = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    const io = capture();
    // Without the guard this writes an assignment row that only fails later,
    // in resolveCapabilities, at every specialist launch, instead of on the
    // command that typed it.
    const code = await runCli(
      ["capability", "enable", "style.caveman@0.1.0",
       "--checksum", `sha256:${"0".repeat(64)}`, "--for", "coding.codey"],
      io.io
    );
    assert.equal(code, 1);
    assert.match(io.err.join("\n"), /style\.caveman@0\.1\.0/);
    // Nothing was written: the assignments file must not exist yet.
    assert.equal(fs.existsSync(path.join(home, "capability-assignments.json")), false);
  } finally {
    if (prior === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prior;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
