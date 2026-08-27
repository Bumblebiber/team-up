// The store could always select a version; nothing on the CLI could ask it to.
// A second install therefore sat on disk, indexed and unreachable — which is
// how a specialist ran an old version carrying one fewer skill than intended.
// These tests cover the CLI path specifically; store-level pinning is covered
// in install-atomic.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.mjs";
import { resolveInstalled } from "../../src/specialists/store.mjs";

function validManifest(overrides = {}) {
  return {
    schema_version: 1,
    id: "testing.pincli",
    display_name: "PinCli",
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
    ...overrides,
  };
}

function writePkg(dir, manifest) {
  fs.writeFileSync(path.join(dir, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evals", "evals.json"), "[]");
}

// cmdSpecialist reads process.env directly rather than taking an env argument,
// so the isolated home has to be installed there for the duration.
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pincli-"));
  const prev = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function installVersions(versions) {
  for (const version of versions) {
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
    writePkg(pkg, validManifest({ version }));
    const code = await runCli(["specialist", "install", pkg], { out: () => {}, err: () => {} });
    assert.equal(code, 0, `install ${version} failed`);
    fs.rmSync(pkg, { recursive: true, force: true });
  }
}

test("specialist pin selects an installed version through the CLI", async () => {
  await withHome(async () => {
    await installVersions(["0.1.0", "0.2.0"]);
    const env = { ...process.env };
    assert.equal(
      resolveInstalled("testing.pincli", { env }).version,
      "0.1.0",
      "install must not repoint an existing selection"
    );

    const out = [];
    const code = await runCli(
      ["specialist", "pin", "testing.pincli@0.2.0"],
      { out: (l) => out.push(l), err: (l) => out.push(l) }
    );
    assert.equal(code, 0, out.join("\n"));
    assert.equal(JSON.parse(out.join("\n")).ok, true);
    assert.equal(resolveInstalled("testing.pincli", { env }).version, "0.2.0");
  });
});

test("specialist pin --project scopes the selection to one project", async () => {
  await withHome(async () => {
    await installVersions(["0.1.0", "0.2.0"]);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-proj-"));
    const code = await runCli(
      ["specialist", "pin", "testing.pincli@0.2.0", "--project", project],
      { out: () => {}, err: () => {} }
    );
    assert.equal(code, 0);
    const env = { ...process.env };
    assert.equal(resolveInstalled("testing.pincli", { project, env }).version, "0.2.0");
    assert.equal(
      resolveInstalled("testing.pincli", { env }).version,
      "0.1.0",
      "a project pin must not move the global selection"
    );
    fs.rmSync(project, { recursive: true, force: true });
  });
});

test("specialist pin refuses a version that is not installed", async () => {
  await withHome(async () => {
    await installVersions(["0.1.0"]);
    const out = [];
    const code = await runCli(
      ["specialist", "pin", "testing.pincli@9.9.9"],
      { out: (l) => out.push(l), err: (l) => out.push(l) }
    );
    assert.equal(code, 1);
    assert.match(out.join("\n"), /no installed version/);
  });
});

test("specialist pin requires <id>@<version>", async () => {
  const errs = [];
  const code = await runCli(["specialist", "pin", "testing.pincli"], {
    out: () => {},
    err: (l) => errs.push(l),
  });
  assert.equal(code, 1);
  assert.match(errs.join("\n"), /<id>@<version>/);
});
