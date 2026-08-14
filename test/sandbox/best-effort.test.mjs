import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wrapWithSandbox, createProbeArtifacts, evaluateProbeOutput } from "../../src/sandbox/systemd.mjs";
import { installPackage } from "../../src/specialists/store.mjs";
import { approveSpecialist } from "../../src/specialists/approvals.mjs";
import { launch } from "../../src/specialists/launcher.mjs";
import {
  verifiedClaudeRoster,
  verifiedHarnessEnv,
} from "../helpers/verified-harness.mjs";

test("ineffective host sandbox falls back with an audit warning", () => {
  const result = wrapWithSandbox({
    command: ["/usr/bin/true"],
    permissions: { filesystem: "project", network: false, writes: false },
    cwd: "/tmp",
    projectPath: "/tmp",
    probe: () => false,
    enforcement: "best_effort",
  });
  assert.deepEqual(result.argv, ["/usr/bin/true"]);
  assert.equal(result.sandbox, "none");
  assert.equal(result.enforced, false);
  assert.match(result.warning, /best-effort sandbox unavailable/);
});

test("effective host sandbox is still used", () => {
  const result = wrapWithSandbox({
    command: ["/usr/bin/true"],
    permissions: { filesystem: "project", network: false, writes: false },
    cwd: "/tmp",
    projectPath: "/tmp",
    packagePath: "/tmp",
    runPath: "/tmp",
    cliPath: "/usr/bin/true",
    sandboxRuntimePaths: ["/usr/bin"],
    probe: () => true,
    enforcement: "best_effort",
  });
  assert.equal(result.sandbox, "systemd-run-user");
  assert.equal(result.enforced, true);
});

test("required enforcement still fails closed", () => {
  assert.throws(
    () =>
      wrapWithSandbox({
        command: ["/usr/bin/true"],
        permissions: { filesystem: "project", network: false, writes: false },
        cwd: "/tmp",
        projectPath: "/tmp",
        probe: () => false,
        enforcement: "required",
      }),
    (e) => e.code === "SANDBOX_UNAVAILABLE"
  );
});

test("noexec probe artifact lives outside home while sentinel stays under home", () => {
  const artifacts = createProbeArtifacts();
  try {
    assert.ok(artifacts.sentinel.startsWith(os.homedir() + path.sep));
    assert.equal(artifacts.noexecScript.startsWith(os.homedir() + path.sep), false);
    assert.ok(fs.existsSync(artifacts.noexecScript));
  } finally {
    artifacts.cleanup();
  }
});

test("home hide alone without noexec block is not enough", () => {
  assert.equal(evaluateProbeOutput("ENFORCEMENT_OK"), true);
  assert.equal(evaluateProbeOutput("HOME_VISIBLE\nENFORCEMENT_OK"), false);
  assert.equal(evaluateProbeOutput("NOEXEC_FAILED\nENFORCEMENT_OK"), false);
  assert.equal(evaluateProbeOutput("HOME_VISIBLE\nNOEXEC_FAILED"), false);
});

test("specialist launch proceeds with best-effort when probe fails", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-be-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-be-proj-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-be-pkg-"));
  const env = { ...process.env, ...verifiedHarnessEnv(home) };
  const prev = { ...process.env };
  Object.assign(process.env, env);
  try {
    fs.writeFileSync(env.TEAM_UP_ROSTER, JSON.stringify(verifiedClaudeRoster()));
    fs.writeFileSync(env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));
    fs.writeFileSync(
      path.join(pkg, "specialist.json"),
      JSON.stringify({
        schema_version: 1,
        id: "testing.beste",
        display_name: "BestE",
        version: "0.1.0",
        remit: ["x"],
        anti_remit: ["y"],
        call_types: ["consult"],
        accepted_inputs: ["task_description"],
        output_contract: "team-up.result/v1",
        capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
        permissions: { filesystem: "project_readonly", writes: false, network: false, commands: [] },
        budget: { timeout_seconds: 60 },
        model_profile: { tier: "medium", reasoning: "low" },
        eval_suite: "evals/evals.json",
      })
    );
    fs.writeFileSync(path.join(pkg, "instructions.md"), "hi\n");
    fs.mkdirSync(path.join(pkg, "evals"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "evals", "evals.json"), "[]");
    assert.equal((await installPackage(pkg, env)).ok, true);
    assert.equal(
      (await approveSpecialist({ idAtVersion: "testing.beste@0.1.0", project, env })).ok,
      true
    );
    const result = await launch({
      specialistId: "testing.beste",
      callType: "consult",
      objective: "sandbox best effort",
      project,
      env,
      dryRun: true,
      sandbox: { probe: () => false },
    });
    assert.equal(result.sandbox, "none");
    assert.equal(result.enforced, false);
    assert.match(result.sandbox_warning || "", /best-effort sandbox unavailable/);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});
