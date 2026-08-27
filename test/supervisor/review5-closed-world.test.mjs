import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { createRun, runDir } from "../../src/runs/runs.mjs";
import {
  buildLaunchDescriptor,
  persistLaunchDescriptor,
  loadAuthoritativeLaunchDescriptor,
  prepareArgvFromDescriptor,
  buildCapsuleLaunchRecord,
  reconstructCapsuleFromLaunchRecord,
  startFromLaunchDescriptor,
} from "../../src/supervisor/start.mjs";
import { buildCapsuleContentManifest } from "../../src/capabilities/content-manifest.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";
import { getAdapter, harnessCapabilities } from "../../src/harness/registry.mjs";

function withTempEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r5-cw-"));
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

function persistCapsuleRun(cli = "claude", model = "m1") {
  const run = createRun({
    cwd: "/tmp",
    role: "specialist:reanna",
    parent: { cli: "team-up", attach: "manual" },
    worker: { cli, model },
    prompt: "hi",
  });
  const rd = runDir(run.runId);
  const capsule = materializeMiniCapsule(rd);
  const capsuleLaunch = buildCapsuleLaunchRecord({ runRoot: rd, capsule });
  const promptPath = path.join(rd, "mailbox", "PROMPT.md");
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, "do work\n");
  const version = getAdapter(cli).version({ execFileSync });
  persistLaunchDescriptor(
    run.runId,
    buildLaunchDescriptor({
      cli,
      model,
      promptPath,
      contextDir: path.join(rd, "context"),
      project: "/tmp",
      permissions: { filesystem: "none", writes: false, network: false, commands: [] },
      callType: "consult",
      harnessRequirements: { context_isolation: CONTEXT_ISOLATION_CAPABILITY },
      harnessVerification: {
        status: "verified",
        adapter: cli,
        cli_version: version,
        context_isolation: CONTEXT_ISOLATION_CAPABILITY,
      },
      capsuleLaunch,
      specialist: { id: "research.reanna", version: "0.1.0" },
    })
  );
  return { runId: run.runId, rd, version };
}

test("closed-world rejects extra symlink under skill root", async () => {
  await withTempEnv(async () => {
    const { runId, rd } = persistCapsuleRun();
    fs.symlinkSync("/etc/hosts", path.join(rd, "context", "skills", "evil-link"));
    assert.throws(
      () => prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(runId)),
      /CONTENT_MANIFEST_(UNEXPECTED|NONREGULAR|SYMLINK)/
    );
  });
});

test("closed-world rejects FIFO under skill root", async () => {
  await withTempEnv(async () => {
    const { runId, rd } = persistCapsuleRun();
    const fifo = path.join(rd, "context", "skills", "evil.fifo");
    spawnSync("mkfifo", [fifo], { stdio: "ignore" });
    assert.equal(fs.existsSync(fifo), true);
    assert.throws(
      () => prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(runId)),
      /CONTENT_MANIFEST_(UNEXPECTED|NONREGULAR)/
    );
  });
});

test("closed-world rejects SKILL.md replaced by same-content external symlink", async () => {
  await withTempEnv(async () => {
    const { runId, rd } = persistCapsuleRun();
    const skillMd = path.join(rd, "context", "skills", "capsule.selected-skill", "SKILL.md");
    const external = path.join(os.tmpdir(), `tu-r5-ext-${Date.now()}.md`);
    fs.writeFileSync(external, fs.readFileSync(skillMd));
    fs.rmSync(skillMd);
    fs.symlinkSync(external, skillMd);
    assert.throws(
      () => prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(runId)),
      /CONTENT_MANIFEST_(SYMLINK|NONREGULAR|CHECKSUM|PATH)/
    );
    fs.rmSync(external, { force: true });
  });
});

test("closed-world rejects extra file under harness/mcp", async () => {
  await withTempEnv(async () => {
    const { runId, rd } = persistCapsuleRun();
    fs.writeFileSync(path.join(rd, "harness", "mcp", "evil.json"), "{}\n");
    assert.throws(
      () => prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(runId)),
      /CONTENT_MANIFEST_UNEXPECTED_FILE/
    );
  });
});

test("build rejects skillDirs outside runRoot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r5-escape-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tu-r5-out-"));
  try {
    const skill = path.join(outside, "skills");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "# x\n");
    const effectivePath = path.join(root, "EFFECTIVE_CAPABILITIES.json");
    fs.writeFileSync(effectivePath, "{}\n");
    assert.throws(
      () =>
        buildCapsuleContentManifest({
          runRoot: root,
          skillDirs: [skill],
          pluginDirs: [],
          frameworkDirs: [],
          mcpConfig: { mcpServers: {} },
          effectivePath,
        }),
      /CONTENT_MANIFEST_(ROOT_ESCAPE|PATH_OUTSIDE)/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("reconstruction requires authoritative content manifest path (no embedded fallback)", async () => {
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
    const launch = buildCapsuleLaunchRecord({ runRoot: rd, capsule });
    assert.throws(
      () =>
        reconstructCapsuleFromLaunchRecord({
          ...launch,
          authoritative_effective_path: capsule.effectivePath,
          authoritative_content_manifest_path: null,
        }),
      /CONTENT_MANIFEST_MISSING|AUTHORITATIVE/
    );
  });
});

test("verified record missing adapter is invalid under exact-version gate", () => {
  const caps = harnessCapabilities("claude", {
    verification: {
      status: "verified",
      cli_version: "2.1.220",
      context_isolation: CONTEXT_ISOLATION_CAPABILITY,
    },
    requireExactVersion: "2.1.220",
  });
  assert.equal(caps.context_isolation, null);
});

test("verified record missing cli_version is invalid under exact-version gate", () => {
  const caps = harnessCapabilities("claude", {
    verification: {
      status: "verified",
      adapter: "claude",
      context_isolation: CONTEXT_ISOLATION_CAPABILITY,
    },
    requireExactVersion: "2.1.220",
  });
  assert.equal(caps.context_isolation, null);
});

test("live version probe failure fails closed before launch", async () => {
  await withTempEnv(async () => {
    const { runId } = persistCapsuleRun();
    assert.throws(
      () =>
        prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(runId), {
          execFileSync: () => {
            throw new Error("version probe boom");
          },
        }),
      /HARNESS_VERIFICATION_VERSION/
    );
  });
});

test("closed-world walk rejects directory symlink under skill root", async () => {
  await withTempEnv(async () => {
    const { runId, rd } = persistCapsuleRun();
    const skillRoot = path.join(rd, "context", "skills");
    const nested = path.join(skillRoot, "selected.skill", "nested-dir");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "x.md"), "x\n");
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "tu-ext-dir-"));
    fs.writeFileSync(path.join(external, "x.md"), "x\n");
    fs.rmSync(nested, { recursive: true, force: true });
    fs.symlinkSync(external, nested);
    assert.throws(
      () => prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(runId)),
      /CONTENT_MANIFEST_SYMLINK/
    );
  });
});

test("rejected Claude-to-Codex runtime override leaves descriptor unchanged", async () => {
  await withTempEnv(async (home) => {
    const { runId } = persistCapsuleRun();
    const descPath = path.join(home, "launch-descriptors", runId, "descriptor.json");
    const before = fs.readFileSync(descPath);
    const beforeSum = crypto.createHash("sha256").update(before).digest("hex");
    assert.throws(
      () =>
        startFromLaunchDescriptor({
          runId,
          runtimeOverride: { cli: "codex", model: "cx" },
          startTmux: () => {
            throw new Error("should not start");
          },
        }),
      /HARNESS_VERIFICATION_ADAPTER|HARNESS_CONTEXT_ISOLATION|BROKER_VERIFY/
    );
    const after = fs.readFileSync(descPath);
    assert.equal(
      crypto.createHash("sha256").update(after).digest("hex"),
      beforeSum,
      "descriptor must be byte-for-byte unchanged after rejected override"
    );
    assert.equal(JSON.parse(after.toString("utf8")).cli, "claude");
  });
});

test("closed-world rejects extra sibling under harness/plugins", async () => {
  await withTempEnv(async () => {
    const { runId, rd } = persistCapsuleRun();
    const evil = path.join(rd, "harness", "plugins", "evil-plugin", "plugin.json");
    fs.mkdirSync(path.dirname(evil), { recursive: true });
    fs.writeFileSync(evil, "{}\n");
    assert.throws(
      () => prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(runId)),
      /CONTENT_MANIFEST_UNEXPECTED_FILE/
    );
  });
});

test("unmodified closed-world reconstruction still succeeds", async () => {
  await withTempEnv(async () => {
    const { runId } = persistCapsuleRun();
    const prepared = prepareArgvFromDescriptor(loadAuthoritativeLaunchDescriptor(runId));
    assert.equal(prepared.argv.includes("--bare"), false);
    assert.ok(prepared.env.HOME);
  });
});
