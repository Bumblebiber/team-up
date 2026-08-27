import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRun, runDir } from "../../src/runs/runs.mjs";
import {
  buildLaunchDescriptor,
  persistLaunchDescriptor,
  loadAuthoritativeLaunchDescriptor,
  prepareArgvFromDescriptor,
  buildCapsuleLaunchRecord,
  reconstructCapsuleFromLaunchRecord,
  CAPSULE_LAUNCH_SCHEMA,
} from "../../src/supervisor/start.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";
import { getAdapter } from "../../src/harness/registry.mjs";
import { execFileSync } from "node:child_process";

function withTempEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-cap-desc-"));
  const prev = {
    TEAM_UP_HOME: process.env.TEAM_UP_HOME,
    TEAM_UP_RUNS: process.env.TEAM_UP_RUNS,
    TEAM_UP_ROSTER: process.env.TEAM_UP_ROSTER,
    TEAM_UP_USAGE: process.env.TEAM_UP_USAGE,
    TEAM_UP_SANDBOX_FORCE_NONE: process.env.TEAM_UP_SANDBOX_FORCE_NONE,
  };
  process.env.TEAM_UP_HOME = home;
  process.env.TEAM_UP_RUNS = path.join(home, "runs");
  process.env.TEAM_UP_ROSTER = path.join(home, "roster.json");
  process.env.TEAM_UP_USAGE = path.join(home, "usage.json");
  process.env.TEAM_UP_SANDBOX_FORCE_NONE = "1";
  fs.writeFileSync(
    process.env.TEAM_UP_ROSTER,
    JSON.stringify({
      accounts: { anthropic: { kind: "subscription", enabled: true } },
      clis: {
        claude: { cmd: ["claude", "--print", "{prompt}"] },
        codex: { cmd: ["codex", "exec", "{prompt}"] },
      },
      models: {
        m1: {
          tier: "frontier",
          cli: ["claude"],
          account: "anthropic",
          provider: "anthropic",
          reasoning: { max: null },
          priority: 1,
          limit_windows: ["claude:5h"],
        },
        cx: {
          tier: "frontier",
          cli: ["codex"],
          account: "anthropic",
          provider: "openai",
          reasoning: { max: null },
          priority: 2,
          limit_windows: [],
        },
      },
      limits: { handoff_at: 0.95 },
    })
  );
  fs.writeFileSync(process.env.TEAM_UP_USAGE, JSON.stringify({ windows: {} }));
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(home, { recursive: true, force: true });
    });
}

function materializeMiniCapsule(runRoot, { withMcp = true } = {}) {
  const skillDir = path.join(runRoot, "context", "skills", "capsule.selected-skill");
  const frameworkDir = path.join(runRoot, "context", "framework", "capsule.selected-framework");
  const pluginDir = path.join(runRoot, "harness", "plugins", "capsule.selected-plugin");
  const mcpDir = path.join(runRoot, "harness", "mcp", "selected");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(frameworkDir, { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# skill\n");
  fs.writeFileSync(path.join(frameworkDir, "framework.json"), "{}\n");
  fs.writeFileSync(path.join(pluginDir, "plugin.json"), "{}\n");
  const mcpConfig = withMcp
    ? {
        mcpServers: {
          selected: {
            type: "stdio",
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
          },
        },
      }
    : { mcpServers: {} };
  if (withMcp) {
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(path.join(mcpDir, "mcp.json"), JSON.stringify(mcpConfig));
  }
  const effective = {
    schema_version: 1,
    specialist_id: "research.reanna",
    packages: [],
    exclusions: [],
    totals: { estimated_description_tokens: 0, mcp_tool_count: 0 },
  };
  const effectivePath = path.join(runRoot, "EFFECTIVE_CAPABILITIES.json");
  fs.writeFileSync(effectivePath, `${JSON.stringify(effective, null, 2)}\n`);
  const codexHome = path.join(runRoot, "harness", "home");
  fs.mkdirSync(codexHome, { recursive: true });
  return {
    pluginDirs: [pluginDir],
    skillDirs: [path.join(runRoot, "context", "skills")],
    frameworkDirs: [path.join(runRoot, "context", "framework")],
    codexHome,
    mcpConfig,
    mcpToolNames: withMcp ? ["mcp__selected__lookup"] : [],
    mcpToolsByServer: withMcp ? { selected: ["lookup"] } : {},
    effective,
    effectivePath,
  };
}

test("prepareArgvFromDescriptor rebuilds Claude bare capsule from persisted descriptor", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:reanna",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const rd = runDir(run.runId);
    const capsule = materializeMiniCapsule(rd);
    const capsuleLaunch = buildCapsuleLaunchRecord({
      runRoot: rd,
      capsule,
      env: process.env,
    });
    assert.equal(capsuleLaunch.schema, CAPSULE_LAUNCH_SCHEMA);

    const promptPath = path.join(rd, "mailbox", "PROMPT.md");
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "do work\n");
    const claudeVersion = getAdapter("claude").version({ execFileSync });
    const desc = buildLaunchDescriptor({
      cli: "claude",
      model: "m1",
      promptPath,
      contextDir: path.join(rd, "context"),
      project: "/tmp",
      permissions: { filesystem: "none", writes: false, network: false, commands: [] },
      callType: "consult",
      harnessRequirements: { context_isolation: CONTEXT_ISOLATION_CAPABILITY },
      harnessVerification: {
        status: "verified",
        adapter: "claude",
        cli_version: claudeVersion,
        context_isolation: CONTEXT_ISOLATION_CAPABILITY,
      },
      capsuleLaunch,
      specialist: { id: "research.reanna", version: "0.1.0" },
    });
    persistLaunchDescriptor(run.runId, desc);

    const prepared = prepareArgvFromDescriptor(
      loadAuthoritativeLaunchDescriptor(run.runId)
    );
    assert.equal(prepared.argv.includes("--bare"), false);
    assert.ok(prepared.env.HOME);
    assert.equal(prepared.argv.includes("--strict-mcp-config"), true);
    assert.ok(prepared.argv.includes("--plugin-dir"));
    assert.ok(
      prepared.argv.some((a, i) =>
        prepared.argv[i - 1] === "--plugin-dir" && a === capsule.pluginDirs[0]
      )
    );
    // Skills are materialized into sanitized HOME; frameworks stay on --add-dir.
    assert.equal(
      prepared.argv.some((a, i) =>
        prepared.argv[i - 1] === "--add-dir" && a === capsule.skillDirs[0]
      ),
      false
    );
    assert.ok(
      prepared.argv.some((a, i) =>
        prepared.argv[i - 1] === "--add-dir" && a === capsule.frameworkDirs[0]
      )
    );
    assert.equal(
      fs.existsSync(path.join(
        prepared.env.HOME, ".claude", "skills", "capsule.selected-skill", "SKILL.md"
      )),
      true
    );
    assert.ok(prepared.home_generation);
  });
});

test("prepareArgvFromDescriptor fails closed for Codex isolation (no native full matrix)", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:reanna",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "codex", model: "cx" },
      prompt: "hi",
    });
    const rd = runDir(run.runId);
    const capsule = materializeMiniCapsule(rd, { withMcp: false });
    const capsuleLaunch = buildCapsuleLaunchRecord({
      runRoot: rd,
      capsule,
      env: process.env,
    });
    const promptPath = path.join(rd, "mailbox", "PROMPT.md");
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "do work\n");
    const codexVersion = getAdapter("codex").version({ execFileSync });

    persistLaunchDescriptor(
      run.runId,
      buildLaunchDescriptor({
        cli: "codex",
        model: "cx",
        promptPath,
        contextDir: path.join(rd, "context"),
        project: "/tmp",
        permissions: { filesystem: "none", writes: false, network: false, commands: [] },
        callType: "consult",
        harnessRequirements: { context_isolation: CONTEXT_ISOLATION_CAPABILITY },
        harnessVerification: {
          status: "verified",
          adapter: "codex",
          cli_version: codexVersion,
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
        },
        capsuleLaunch,
        specialist: { id: "research.reanna", version: "0.1.0" },
      })
    );
    // Declared context_isolation is null — verification token cannot unlock capsules.
    assert.throws(
      () => prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(run.runId)),
      /HARNESS_CONTEXT_ISOLATION_UNVERIFIED|BROKER_VERIFY_FAILED/
    );

    // Missing isolation token still fails closed.
    assert.throws(
      () =>
        prepareArgvFromDescriptor(
          buildLaunchDescriptor({
            cli: "codex",
            model: "cx",
            promptPath,
            contextDir: path.join(rd, "context"),
            project: "/tmp",
            permissions: { filesystem: "none", writes: false, network: false, commands: [] },
            callType: "consult",
            harnessRequirements: { context_isolation: CONTEXT_ISOLATION_CAPABILITY },
            harnessVerification: {
              status: "verified",
              adapter: "codex",
              cli_version: codexVersion,
              context_isolation: null,
            },
            capsuleLaunch: {
              ...capsuleLaunch,
              authoritative_effective_path:
                loadAuthoritativeLaunchDescriptor(run.runId).capsule_launch
                  .authoritative_effective_path,
              authoritative_content_manifest_path:
                loadAuthoritativeLaunchDescriptor(run.runId).capsule_launch
                  .authoritative_content_manifest_path,
            },
            specialist: { id: "research.reanna", version: "0.1.0" },
          })
        ),
      /HARNESS_CONTEXT_ISOLATION_UNVERIFIED|BROKER_VERIFY_FAILED/
    );
  });
});

test("Claude verification cannot be reused under Codex runtime override", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:reanna",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const rd = runDir(run.runId);
    const capsule = materializeMiniCapsule(rd);
    const capsuleLaunch = buildCapsuleLaunchRecord({
      runRoot: rd,
      capsule,
      env: process.env,
    });
    const promptPath = path.join(rd, "mailbox", "PROMPT.md");
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "do work\n");
    const claudeVersion = getAdapter("claude").version({ execFileSync });
    persistLaunchDescriptor(
      run.runId,
      buildLaunchDescriptor({
        cli: "claude",
        model: "m1",
        promptPath,
        contextDir: path.join(rd, "context"),
        project: "/tmp",
        permissions: { filesystem: "none", writes: false, network: false, commands: [] },
        callType: "consult",
        harnessRequirements: { context_isolation: CONTEXT_ISOLATION_CAPABILITY },
        harnessVerification: {
          status: "verified",
          adapter: "claude",
          cli_version: claudeVersion,
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
        },
        capsuleLaunch,
        specialist: { id: "research.reanna", version: "0.1.0" },
      })
    );
    assert.throws(
      () =>
        prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(run.runId), {
          runtimeOverride: { cli: "codex", model: "cx" },
        }),
      /HARNESS_VERIFICATION_ADAPTER|HARNESS_CONTEXT_ISOLATION|BROKER_VERIFY/
    );
  });
});

test("missing or corrupt capsule launch data fails closed", async () => {
  await withTempEnv(async (home) => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:reanna",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const rd = runDir(run.runId);
    const capsule = materializeMiniCapsule(rd);
    const capsuleLaunch = buildCapsuleLaunchRecord({
      runRoot: rd,
      capsule,
      env: process.env,
    });
    const promptPath = path.join(rd, "mailbox", "PROMPT.md");
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "do work\n");
    persistLaunchDescriptor(
      run.runId,
      buildLaunchDescriptor({
        cli: "claude",
        model: "m1",
        promptPath,
        contextDir: path.join(rd, "context"),
        project: "/tmp",
        permissions: { filesystem: "none", writes: false, network: false, commands: [] },
        callType: "consult",
        harnessRequirements: { context_isolation: CONTEXT_ISOLATION_CAPABILITY },
        harnessVerification: {
          status: "verified",
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
        },
        capsuleLaunch,
        specialist: { id: "research.reanna", version: "0.1.0" },
      })
    );

    assert.throws(
      () =>
        prepareArgvFromDescriptor(
          buildLaunchDescriptor({
            cli: "claude",
            model: "m1",
            promptPath,
            contextDir: path.join(rd, "context"),
            project: "/tmp",
            permissions: { filesystem: "none", writes: false, network: false, commands: [] },
            callType: "consult",
            harnessRequirements: { context_isolation: CONTEXT_ISOLATION_CAPABILITY },
            harnessVerification: {
              status: "verified",
              context_isolation: CONTEXT_ISOLATION_CAPABILITY,
            },
            specialist: { id: "research.reanna", version: "0.1.0" },
          })
        ),
      /CAPSULE_LAUNCH/
    );

    const authPath = path.join(home, "launch-descriptors", run.runId, "descriptor.json");
    const body = JSON.parse(fs.readFileSync(authPath, "utf8"));
    body.capsule_launch.effective_checksum = "sha256:deadbeef";
    fs.chmodSync(authPath, 0o644);
    fs.writeFileSync(authPath, `${JSON.stringify(body, null, 2)}\n`);
    const sumPath = path.join(home, "launch-descriptors", run.runId, "descriptor.sha256");
    fs.chmodSync(sumPath, 0o644);
    const nextBody = `${JSON.stringify(body, null, 2)}\n`;
    fs.writeFileSync(
      sumPath,
      `sha256:${crypto.createHash("sha256").update(nextBody).digest("hex")}\n`
    );
    assert.throws(
      () => prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(run.runId)),
      /CAPSULE_LAUNCH|CHECKSUM/
    );

    assert.throws(
      () =>
        reconstructCapsuleFromLaunchRecord({
          ...capsuleLaunch,
          authoritative_effective_path: capsule.effectivePath,
          authoritative_content_manifest_path: null,
          effective_checksum: "sha256:nope",
        }),
      /CAPSULE_LAUNCH_CHECKSUM/
    );
  });
});

test("reconstruction fails closed when selected SKILL.md content is mutated", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:reanna",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const rd = runDir(run.runId);
    const capsule = materializeMiniCapsule(rd);
    const capsuleLaunch = buildCapsuleLaunchRecord({
      runRoot: rd,
      capsule,
      env: process.env,
    });
    const promptPath = path.join(rd, "mailbox", "PROMPT.md");
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "do work\n");
    persistLaunchDescriptor(
      run.runId,
      buildLaunchDescriptor({
        cli: "claude",
        model: "m1",
        promptPath,
        contextDir: path.join(rd, "context"),
        project: "/tmp",
        permissions: { filesystem: "none", writes: false, network: false, commands: [] },
        callType: "consult",
        harnessRequirements: { context_isolation: CONTEXT_ISOLATION_CAPABILITY },
        harnessVerification: {
          status: "verified",
          adapter: "claude",
          cli_version: "2.1.220",
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
        },
        capsuleLaunch,
        specialist: { id: "research.reanna", version: "0.1.0" },
      })
    );

    const skillMd = path.join(
      rd, "context", "skills", "capsule.selected-skill", "SKILL.md"
    );
    fs.writeFileSync(skillMd, "# skill\nMUTATED\n");

    assert.throws(
      () => prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(run.runId)),
      /CONTENT_MANIFEST_CHECKSUM|CAPSULE_LAUNCH/
    );
  });
});

test("reconstruction fails closed when selected skill root is deleted (no recreate)", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:reanna",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const rd = runDir(run.runId);
    const capsule = materializeMiniCapsule(rd);
    const capsuleLaunch = buildCapsuleLaunchRecord({
      runRoot: rd,
      capsule,
      env: process.env,
    });
    const promptPath = path.join(rd, "mailbox", "PROMPT.md");
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "do work\n");
    persistLaunchDescriptor(
      run.runId,
      buildLaunchDescriptor({
        cli: "claude",
        model: "m1",
        promptPath,
        contextDir: path.join(rd, "context"),
        project: "/tmp",
        permissions: { filesystem: "none", writes: false, network: false, commands: [] },
        callType: "consult",
        harnessRequirements: { context_isolation: CONTEXT_ISOLATION_CAPABILITY },
        harnessVerification: {
          status: "verified",
          adapter: "claude",
          cli_version: "2.1.220",
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
        },
        capsuleLaunch,
        specialist: { id: "research.reanna", version: "0.1.0" },
      })
    );

    const skillRoot = path.join(rd, "context", "skills");
    fs.rmSync(skillRoot, { recursive: true, force: true });

    assert.throws(
      () => prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(run.runId)),
      /CONTENT_MANIFEST_PATH_MISSING|CAPSULE_LAUNCH_PATH_MISSING/
    );
    assert.equal(fs.existsSync(skillRoot), false, "must not recreate missing skill root");
  });
});

test("reconstruction never falls back to worker-writable EFFECTIVE_CAPABILITIES", async () => {
  await withTempEnv(async (home) => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:reanna",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const rd = runDir(run.runId);
    const capsule = materializeMiniCapsule(rd);
    const capsuleLaunch = buildCapsuleLaunchRecord({
      runRoot: rd,
      capsule,
      env: process.env,
    });
    const promptPath = path.join(rd, "mailbox", "PROMPT.md");
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "do work\n");
    persistLaunchDescriptor(
      run.runId,
      buildLaunchDescriptor({
        cli: "claude",
        model: "m1",
        promptPath,
        contextDir: path.join(rd, "context"),
        project: "/tmp",
        permissions: { filesystem: "none", writes: false, network: false, commands: [] },
        callType: "consult",
        harnessRequirements: { context_isolation: CONTEXT_ISOLATION_CAPABILITY },
        harnessVerification: {
          status: "verified",
          adapter: "claude",
          cli_version: "2.1.220",
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
        },
        capsuleLaunch,
        specialist: { id: "research.reanna", version: "0.1.0" },
      })
    );

    const authEffective = path.join(
      home, "launch-descriptors", run.runId, "EFFECTIVE_CAPABILITIES.json"
    );
    fs.chmodSync(authEffective, 0o644);
    fs.rmSync(authEffective, { force: true });

    // Worker-writable copy still present and valid — must still fail closed.
    assert.equal(fs.existsSync(path.join(rd, "EFFECTIVE_CAPABILITIES.json")), true);
    assert.throws(
      () => prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(run.runId)),
      /CAPSULE_LAUNCH_EFFECTIVE_MISSING|CONTENT_MANIFEST/
    );
  });
});

test("reconstruction fails closed when unlisted file is added under skill root", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:reanna",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const rd = runDir(run.runId);
    const capsule = materializeMiniCapsule(rd);
    const capsuleLaunch = buildCapsuleLaunchRecord({
      runRoot: rd,
      capsule,
      env: process.env,
    });
    const promptPath = path.join(rd, "mailbox", "PROMPT.md");
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "do work\n");
    const claudeVersion = getAdapter("claude").version({ execFileSync });
    persistLaunchDescriptor(
      run.runId,
      buildLaunchDescriptor({
        cli: "claude",
        model: "m1",
        promptPath,
        contextDir: path.join(rd, "context"),
        project: "/tmp",
        permissions: { filesystem: "none", writes: false, network: false, commands: [] },
        callType: "consult",
        harnessRequirements: { context_isolation: CONTEXT_ISOLATION_CAPABILITY },
        harnessVerification: {
          status: "verified",
          adapter: "claude",
          cli_version: claudeVersion,
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
        },
        capsuleLaunch,
        specialist: { id: "research.reanna", version: "0.1.0" },
      })
    );

    const evil = path.join(rd, "context", "skills", "evil", "SKILL.md");
    fs.mkdirSync(path.dirname(evil), { recursive: true });
    fs.writeFileSync(evil, "# evil injected\n");

    assert.throws(
      () => prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(run.runId)),
      /CONTENT_MANIFEST_UNEXPECTED_FILE/
    );
  });
});

test("exact unmodified reconstruction succeeds with content manifest", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp",
      role: "specialist:reanna",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" },
      prompt: "hi",
    });
    const rd = runDir(run.runId);
    const capsule = materializeMiniCapsule(rd);
    const capsuleLaunch = buildCapsuleLaunchRecord({
      runRoot: rd,
      capsule,
      env: process.env,
    });
    assert.equal(capsuleLaunch.content_manifest?.schema, "team-up.capsule-content/v1");
    assert.ok(capsuleLaunch.content_root_checksum?.startsWith("sha256:"));
    assert.ok(capsuleLaunch.content_manifest.files.length >= 4);

    const promptPath = path.join(rd, "mailbox", "PROMPT.md");
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "do work\n");
    const claudeVersion = getAdapter("claude").version({ execFileSync });
    persistLaunchDescriptor(
      run.runId,
      buildLaunchDescriptor({
        cli: "claude",
        model: "m1",
        promptPath,
        contextDir: path.join(rd, "context"),
        project: "/tmp",
        permissions: { filesystem: "none", writes: false, network: false, commands: [] },
        callType: "consult",
        harnessRequirements: { context_isolation: CONTEXT_ISOLATION_CAPABILITY },
        harnessVerification: {
          status: "verified",
          adapter: "claude",
          cli_version: claudeVersion,
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
        },
        capsuleLaunch,
        specialist: { id: "research.reanna", version: "0.1.0" },
      })
    );

    const prepared = prepareArgvFromDescriptor(
      loadAuthoritativeLaunchDescriptor(run.runId)
    );
    assert.equal(prepared.argv.includes("--bare"), false);
    assert.ok(prepared.env.HOME);
  });
});
