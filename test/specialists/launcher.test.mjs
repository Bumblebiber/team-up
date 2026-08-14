import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "../../src/specialists/launcher.mjs";
import { wrapWithSandbox } from "../../src/sandbox/systemd.mjs";
import { installPackage } from "../../src/specialists/store.mjs";
import { approveSpecialist } from "../../src/specialists/approvals.mjs";
import { createRun as createRunReal, loadState } from "../../src/runs/runs.mjs";
import {
  verifiedClaudeRoster,
  verifiedHarnessEnv,
} from "../helpers/verified-harness.mjs";

function tmpdir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function specialistManifest(id) {
  return {
    schema_version: 1,
    id,
    display_name: id,
    version: "0.1.0",
    remit: ["x"],
    anti_remit: ["y"],
    call_types: ["consult"],
    accepted_inputs: ["task_description"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
    permissions: {
      filesystem: "project_readonly",
      writes: false,
      network: false,
      commands: [],
    },
    budget: { timeout_seconds: 60 },
    model_profile: { tier: "medium", reasoning: "low" },
    eval_suite: "evals/evals.json",
  };
}

/** Installed + approved specialist against a verified fake Claude harness. */
async function withInstalledSpecialist(id, fn) {
  const home = tmpdir("tu-launch-home-");
  const project = tmpdir("tu-launch-proj-");
  const pkg = tmpdir("tu-launch-pkg-");
  const env = { ...process.env, ...verifiedHarnessEnv(home) };
  const prev = { ...process.env };
  Object.assign(process.env, env);
  try {
    fs.writeFileSync(env.TEAM_UP_ROSTER, JSON.stringify(verifiedClaudeRoster()));
    fs.writeFileSync(env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));
    fs.writeFileSync(
      path.join(pkg, "specialist.json"),
      JSON.stringify(specialistManifest(id))
    );
    fs.writeFileSync(path.join(pkg, "instructions.md"), "hi\n");
    fs.mkdirSync(path.join(pkg, "evals"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "evals", "evals.json"), "[]");
    assert.equal((await installPackage(pkg, env)).ok, true);
    assert.equal(
      (await approveSpecialist({ idAtVersion: `${id}@0.1.0`, project, env })).ok,
      true
    );
    return await fn({ home, project, env });
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(pkg, { recursive: true, force: true });
  }
}

test("launcher refuses required sandbox when probe fails; missing specialist still errors", async () => {
  await assert.rejects(
    async () => {
      wrapWithSandbox({
        command: ["true"],
        permissions: { network: false },
        cwd: "/tmp",
        probe: () => false,
        enforcement: "required",
      });
    },
    /SANDBOX_UNAVAILABLE/
  );
  await assert.rejects(
    () =>
      launch({
        specialistId: "missing",
        callType: "review",
        objective: "x",
        project: "/tmp",
        sandbox: { probe: () => false },
        permissions: { network: false },
      }),
    /not installed/
  );
});

test("capsule failure prevents worker creation", async () => {
  await withInstalledSpecialist("testing.capsulefail", async ({ project, env }) => {
    const events = [];
    let runId = null;
    await assert.rejects(
      () =>
        launch({
          specialistId: "testing.capsulefail",
          callType: "consult",
          objective: "x",
          project,
          env,
          sandbox: { available: true, probe: () => true },
          dependencyOverrides: {
            resolveEffectiveCapabilities: () => {
              events.push("resolve");
              return { packages: [], exclusions: [] };
            },
            createRun: (...args) => {
              events.push("run-record");
              // Real run record: the capsule failure must mark it failed.
              const state = createRunReal(...args);
              runId = state.runId;
              return state;
            },
            materializeCapabilityCapsule: () => {
              events.push("capsule");
              throw Object.assign(new Error("broken capsule"), {
                code: "CAPSULE_BUILD_FAILED",
              });
            },
            startFromLaunchDescriptor: () => events.push("worker"),
          },
        }),
      /broken capsule/
    );
    assert.deepEqual(events, ["resolve", "run-record", "capsule"]);
    assert.equal(events.includes("worker"), false);
    assert.equal(loadState(runId).status, "failed");
  });
});

test("resolution failure prevents any run record", async () => {
  await withInstalledSpecialist("testing.resolvefail", async ({ project, env }) => {
    const events = [];
    await assert.rejects(
      () =>
        launch({
          specialistId: "testing.resolvefail",
          callType: "consult",
          objective: "x",
          project,
          env,
          sandbox: { available: true, probe: () => true },
          dependencyOverrides: {
            resolveEffectiveCapabilities: () => {
              throw new Error("CAPABILITY_VERSION_CONFLICT: a@1, a@2");
            },
            createRun: (...args) => {
              events.push("run-record");
              return createRunReal(...args);
            },
            startFromLaunchDescriptor: () => events.push("worker"),
          },
        }),
      /CAPABILITY_VERSION_CONFLICT/
    );
    assert.deepEqual(events, []);
  });
});

test("a launched specialist records its effective capabilities", async () => {
  await withInstalledSpecialist("testing.capsuleok", async ({ project, env }) => {
    const result = await launch({
      specialistId: "testing.capsuleok",
      callType: "consult",
      objective: "x",
      project,
      env,
      dryRun: true,
      sandbox: { available: true, probe: () => true },
    });
    const state = loadState(result.runId);
    assert.equal(state.harness_requirements.context_isolation, "team-up.context-isolation/v1");
    assert.deepEqual(state.capabilities.packages, []);
    assert.deepEqual(state.capabilities.totals, {
      estimated_description_tokens: 0,
      mcp_tool_count: 0,
    });
    const audit = JSON.parse(
      fs.readFileSync(
        path.join(state.capabilities.capsule_root, "EFFECTIVE_CAPABILITIES.json"),
        "utf8"
      )
    );
    assert.equal(audit.specialist_id, "testing.capsuleok");
    // Global discovery is off: the launch pins an explicit config dir.
    assert.match(result.argv.join(" "), /CLAUDE_CONFIG_DIR=/);
    assert.match(result.argv.join(" "), /--strict-mcp-config/);
  });
});
