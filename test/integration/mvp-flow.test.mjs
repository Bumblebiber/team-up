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
const HANNES = path.join(REPOS, "team-up-with-hannes");
const HUGO = path.join(REPOS, "team-up-with-hugo");

test("mvp flow: install, approve, exact tier, materialize, typed result, reapproval", async () => {
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
    // 1. Import legacy-shaped roster (frontier + medium models)
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
          tier: "frontier",
          cli: ["codex"],
          account: "api",
          reasoning: { max: "xhigh" },
          priority: 1,
        },
        "high-a": {
          tier: "high",
          cli: ["codex"],
          account: "api",
          reasoning: { max: "high" },
          priority: 1,
        },
        "medium-a": {
          tier: "medium",
          cli: ["cursor"],
          account: "cursor",
          reasoning: { low: null },
          priority: 1,
        },
        "low-a": {
          tier: "low",
          cli: ["cursor"],
          account: "cursor",
          reasoning: { low: null },
          priority: 1,
        },
      },
    };
    fs.writeFileSync(env.TEAM_UP_ROSTER, JSON.stringify(roster, null, 2));
    fs.writeFileSync(env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));

    // 2. Install Hannes + Hugo
    const hInstall = await installPackage(HANNES, env);
    const uInstall = await installPackage(HUGO, env);
    assert.equal(hInstall.ok, true, hInstall.errors?.join("; "));
    assert.equal(uInstall.ok, true);

    // 3. Approve Hannes for temp project
    const approval = await approveSpecialist({
      idAtVersion: "testing.hannes@0.1.0",
      project,
      env,
    });
    assert.equal(approval.ok, true);

    // 4–5. Resolve frontier+max only
    const resolved = resolveProfile({
      roster,
      usage: {},
      profile: { tier: "frontier", reasoning: "max" },
    });
    assert.equal(resolved.code, "OK");
    assert.deepEqual(resolved.chain.map((c) => c.model), ["frontier-a"]);
    assert.ok(!resolved.chain.some((c) => ["high-a", "medium-a", "low-a"].includes(c.model)));

    // 6. Create review request
    const request = normalizeRequest({
      specialist_id: "testing.hannes",
      specialist_version: "0.1.0",
      call_type: "review",
      objective: "Review test plan",
      inputs: [],
    });
    assert.equal(request.permissions.writes, false);

    // 7. Materialize only Hannes
    const out = path.join(home, "context-hannes");
    const hannesManifest = JSON.parse(fs.readFileSync(path.join(HANNES, "specialist.json"), "utf8"));
    await materialize({
      packageDir: hInstall.path,
      request,
      destination: out,
      manifest: hannesManifest,
      projectRoot: project,
    });
    assert.equal(await exists(path.join(out, "instructions.md")), true);
    assert.equal(await exists(path.join(out, "team-up-with-hugo")), false);

    // 8. Typed result success
    process.env.TEAM_UP_RUNS = env.TEAM_UP_RUNS;
    const run = createRun({
      cwd: project,
      project,
      role: "specialist:testing.hannes",
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
        id: "testing.hannes",
        version: "0.1.0",
        checksum: hInstall.checksum,
        permissions: hannesManifest.permissions,
        env,
      }),
      true
    );
    assert.equal(
      isApproved({
        project,
        id: "testing.hannes",
        version: "0.1.0",
        checksum: "sha256:deadbeef",
        permissions: hannesManifest.permissions,
        env,
      }),
      false
    );
    assert.notEqual(
      approvalKey({
        project,
        id: "testing.hannes",
        version: "0.1.0",
        checksum: hInstall.checksum,
        permissions: hannesManifest.permissions,
      }),
      approvalKey({
        project,
        id: "testing.hannes",
        version: "0.1.0",
        checksum: "sha256:deadbeef",
        permissions: hannesManifest.permissions,
      })
    );

    // 10. Unavailable tier
    const missing = resolveProfile({
      roster,
      usage: {},
      profile: { tier: "high", reasoning: "max" },
    });
    // high-a exists — use a tier with no models
    const missing2 = resolveProfile({
      roster: { ...roster, models: { "frontier-a": roster.models["frontier-a"] } },
      usage: {},
      profile: { tier: "low", reasoning: "low" },
    });
    assert.equal(missing2.code, "PROFILE_UNAVAILABLE");
    assert.deepEqual(missing2.chain, []);
    // also prove high exists but we can still request unavailable reasoning
    const noReason = resolveProfile({
      roster,
      usage: {},
      profile: { tier: "medium", reasoning: "max" },
    });
    assert.equal(noReason.code, "PROFILE_UNAVAILABLE");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
