import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installPackage } from "../../src/specialists/store.mjs";
import { approveSpecialist, isApproved, approvalKey } from "../../src/specialists/approvals.mjs";
import { resolveProfile } from "../../src/roster/profile.mjs";
import { normalizeRequest } from "../../src/specialists/request.mjs";
import { materialize, exists } from "../../src/sandbox/materialize.mjs";
import { writeTypedResult, createRun, runDir } from "../../src/runs/runs.mjs";
import { sha256Dir } from "../../src/specialists/manifest.mjs";
import { findSpecialistRepos } from "../helpers/specialist-repos.mjs";

const REPOS = findSpecialistRepos(path.dirname(fileURLToPath(import.meta.url)));
const TESSA = path.join(REPOS, "team-up-with-tessa");
const REANNA = path.join(REPOS, "team-up-with-reanna");

test("mvp flow: install, approve, assigned role, materialize, typed result, reapproval", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-mvp-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
  const env = {
    ...process.env,
    TEAM_UP_HOME: home,
    TEAM_UP_RUNS: path.join(home, "runs"),
    TEAM_UP_ROSTER: path.join(home, "roster.json"),
    TEAM_UP_USAGE: path.join(home, "usage.json"),
  };
  // Isolate path helpers that read process.env
  const prev = { ...process.env };
  Object.assign(process.env, env);

  try {
    // 1. Roster: four models, Tessa runs on the reviewer role
    const roster = {
      accounts: {
        api: { kind: "credit", enabled: true, remaining: 10 },
        cursor: { kind: "subscription", enabled: true },
      },
      clis: {
        codex: { cmd: ["codex", "--model", "{model}", "-c", "model_reasoning_effort={effort}", "{prompt}"] },
        cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] },
      },
      models: {
        "frontier-a": {
          cli: ["codex"],
          account: "api",
          reasoning: { max: "xhigh" },
          priority: 1,
        },
        "high-a": {
          cli: ["codex"],
          account: "api",
          reasoning: { max: "high" },
          priority: 1,
        },
        "medium-a": {
          cli: ["cursor"],
          account: "cursor",
          reasoning: { low: null },
          priority: 1,
        },
        "low-a": {
          cli: ["cursor"],
          account: "cursor",
          reasoning: { low: null },
          priority: 1,
        },
      },
      roles: { reviewer: { chain: ["codex:frontier-a"], effort: "xhigh" } },
      specialists: { "testing.tessa": { role: "reviewer" } },
    };
    fs.writeFileSync(env.TEAM_UP_ROSTER, JSON.stringify(roster, null, 2));
    fs.writeFileSync(env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));

    // 2. Install Tessa + Reanna
    const hInstall = await installPackage(TESSA, env);
    const uInstall = await installPackage(REANNA, env);
    assert.equal(hInstall.ok, true, hInstall.errors?.join("; "));
    assert.equal(uInstall.ok, true);

    fs.mkdirSync(path.join(project, ".team-up"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".team-up", "commands.json"),
      JSON.stringify({
        schema_version: 1,
        commands: {
          "project-test": {
            argv: ["npm", "test"],
            cwd: ".",
            timeout_seconds: 1800,
            environment: {},
          },
        },
      })
    );

    // 3. Approve Tessa for temp project
    const approval = await approveSpecialist({
      idAtVersion: "testing.tessa@0.1.0",
      project,
      env,
    });
    assert.equal(approval.ok, true, approval.errors?.join("; "));

    // 4–5. Resolve Tessa's role chain only
    const resolved = resolveProfile({
      roster,
      usage: {},
      specialistId: "testing.tessa",
    });
    assert.equal(resolved.code, "OK");
    assert.deepEqual(resolved.profile, { role: "reviewer" });
    assert.deepEqual(resolved.chain.map((c) => c.model), ["frontier-a"]);
    assert.equal(resolved.chain[0].effort, "xhigh");
    assert.ok(!resolved.chain.some((c) => ["high-a", "medium-a", "low-a"].includes(c.model)));

    // 6. Create review request
    const request = normalizeRequest({
      specialist_id: "testing.tessa",
      specialist_version: "0.1.0",
      call_type: "review",
      objective: "Review test plan",
      inputs: [],
    });
    assert.equal(request.permissions.writes, false);

    // 7. Materialize only Tessa
    const out = path.join(home, "context-tessa");
    const tessaManifest = JSON.parse(fs.readFileSync(path.join(TESSA, "specialist.json"), "utf8"));
    await materialize({
      packageDir: hInstall.path,
      request,
      destination: out,
      manifest: tessaManifest,
      projectRoot: project,
    });
    assert.equal(await exists(path.join(out, "instructions.md")), true);
    assert.equal(await exists(path.join(out, "team-up-with-reanna")), false);

    // 8. Typed result success
    process.env.TEAM_UP_RUNS = env.TEAM_UP_RUNS;
    const run = createRun({
      cwd: project,
      project,
      role: "specialist:testing.tessa",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "codex", model: "frontier-a" },
      prompt: "review",
    });
    const { classified } = writeTypedResult(run.runId, {
      status: "success",
      summary: "looks good",
      runtime: { cli: "codex", model: "frontier-a", effort: "xhigh" },
    });
    assert.equal(classified.status, "done");

    // 9. Checksum change requires reapproval
    assert.equal(
      isApproved({
        project,
        id: "testing.tessa",
        version: "0.1.0",
        checksum: hInstall.checksum,
        permissions: tessaManifest.permissions,
        command_policy_checksum: approval.approval.command_policy_checksum,
        env,
      }),
      true
    );
    assert.equal(
      isApproved({
        project,
        id: "testing.tessa",
        version: "0.1.0",
        checksum: "sha256:deadbeef",
        permissions: tessaManifest.permissions,
        command_policy_checksum: approval.approval.command_policy_checksum,
        env,
      }),
      false
    );
    assert.notEqual(
      approvalKey({
        project,
        id: "testing.tessa",
        version: "0.1.0",
        checksum: hInstall.checksum,
        permissions: tessaManifest.permissions,
        command_policy_checksum: approval.approval.command_policy_checksum,
      }),
      approvalKey({
        project,
        id: "testing.tessa",
        version: "0.1.0",
        checksum: "sha256:deadbeef",
        permissions: tessaManifest.permissions,
        command_policy_checksum: approval.approval.command_policy_checksum,
      })
    );

    // 10. Unavailable assignments
    // Reanna is installed but has no role or chain.
    const unassigned = resolveProfile({ roster, usage: {}, specialistId: "testing.reanna" });
    assert.equal(unassigned.code, "PROFILE_UNAVAILABLE");
    assert.equal(unassigned.profile, null);
    assert.match(unassigned.skipped[0].reason, /no role or chain assigned to testing\.reanna/);
    // A chain naming a model the roster does not have.
    const missing = resolveProfile({
      roster: { ...roster, models: { "frontier-a": roster.models["frontier-a"] } },
      usage: {},
      profile: { chain: ["cursor:low-a"] },
    });
    assert.equal(missing.code, "PROFILE_UNAVAILABLE");
    assert.deepEqual(missing.chain, []);
    assert.deepEqual(missing.skipped, [{ model: "low-a", reason: "not in models" }]);
    // A model that exists, asked for on a CLI it does not run on.
    const wrongCli = resolveProfile({
      roster,
      usage: {},
      profile: { chain: ["cursor:frontier-a"] },
    });
    assert.equal(wrongCli.code, "PROFILE_UNAVAILABLE");
    assert.deepEqual(wrongCli.skipped, [
      { model: "cursor:frontier-a", reason: "frontier-a does not run on cursor" },
    ]);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
