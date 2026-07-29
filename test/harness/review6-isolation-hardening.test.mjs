import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAdapter, materializeClaudeAuthHome } from "../../src/harness/claude.mjs";
import { codexAdapter } from "../../src/harness/codex.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";
import {
  buildIsolationCanaryFixture,
  collectLiveIsolationObservation,
  decideContextIsolationCapability,
  observeContextIsolation,
  parseClaudeStreamToolProof,
  ISOLATION_FORBIDDEN_CANARIES,
} from "../../src/harness/isolation-canary.mjs";
import {
  buildCapsuleContentManifest,
  listDirectoryNoFollow,
  verifyCapsuleContentManifest,
} from "../../src/capabilities/content-manifest.mjs";
import { buildStrictMcpConfig, materializeCapabilityCapsule } from "../../src/capabilities/capsule.mjs";

const SESSION = "sess-r6-220";
const NONCE = "nonce-r6-abc";
const TOOL = "mcp__selected__lookup";

function line(obj) {
  return JSON.stringify(obj);
}

function initEvent() {
  return line({
    type: "system",
    subtype: "init",
    session_id: SESSION,
    tools: ["Read", "ToolSearch", TOOL],
    mcp_servers: [{ name: "selected", status: "connected" }],
    skills: ["capsule.selected-skill"],
    plugins: ["capsule.selected-plugin"],
    claude_code_version: "2.1.220",
  });
}

function prepareClaudeLaunch(fixture) {
  return claudeAdapter.prepareLaunch({
    argv: ["claude", "--print", "probe"],
    runDir: fixture.runRoot,
    capsule: fixture.capsule,
    writeFileSync: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    mkdirSync: (dir, opts) => fs.mkdirSync(dir, opts),
    chmodSync: () => {},
  });
}

function buildHappyInventory(fixture) {
  return {
    skills: ["capsule.selected-skill"],
    plugins: ["capsule.selected-plugin"],
    mcp_tools: ["mcp__selected__lookup"],
    frameworks: ["capsule.selected-framework"],
    absent: [...ISOLATION_FORBIDDEN_CANARIES],
    content_nonces: { ...fixture.expected.nonces },
  };
}

function buildHappySpawnSync(fixture, { inventory, streamLines, mcpNonce } = {}) {
  const inv = inventory ?? buildHappyInventory(fixture);
  const nonce = mcpNonce ?? fixture.expected.nonces.mcp;
  const sessionId = "sess-happy-r6";
  const lines = streamLines ?? [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      tools: ["Read", "ToolSearch", TOOL],
      mcp_servers: [{ name: "selected", status: "connected" }],
      skills: ["capsule.selected-skill"],
      plugins: ["capsule.selected-plugin"],
      claude_code_version: "2.1.220",
    }),
    JSON.stringify({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "tool_use", name: TOOL, id: "tu-1", input: {} }],
      },
    }),
    JSON.stringify({
      type: "user",
      session_id: sessionId,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu-1",
          content: `team-up-canary-ok:${nonce}`,
        }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "text", text: JSON.stringify(inv) }],
      },
    }),
  ];
  return () => ({ status: 0, stdout: `${lines.join("\n")}\n`, stderr: "" });
}

test("stream proof rejects same-event tool_use+tool_result (Claude 2.1.220 envelope)", () => {
  const stream = [
    initEvent(),
    line({
      type: "assistant",
      session_id: SESSION,
      message: {
        content: [
          { type: "tool_use", id: "tu-1", name: TOOL, input: {} },
          { type: "tool_result", tool_use_id: "tu-1", content: `team-up-canary-ok:${NONCE}` },
        ],
      },
    }),
  ].join("\n");
  assert.equal(
    parseClaudeStreamToolProof(stream, { toolName: TOOL, nonce: NONCE }),
    null
  );
});

test("stream proof rejects tool_use on user and tool_result on assistant", () => {
  const badUseRole = [
    initEvent(),
    line({
      type: "user",
      session_id: SESSION,
      message: { content: [{ type: "tool_use", id: "tu-1", name: TOOL, input: {} }] },
    }),
    line({
      type: "user",
      session_id: SESSION,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu-1",
          content: `team-up-canary-ok:${NONCE}`,
        }],
      },
    }),
  ].join("\n");
  assert.equal(
    parseClaudeStreamToolProof(badUseRole, { toolName: TOOL, nonce: NONCE }),
    null
  );

  const badResultRole = [
    initEvent(),
    line({
      type: "assistant",
      session_id: SESSION,
      message: { content: [{ type: "tool_use", id: "tu-1", name: TOOL, input: {} }] },
    }),
    line({
      type: "assistant",
      session_id: SESSION,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu-1",
          content: `team-up-canary-ok:${NONCE}`,
        }],
      },
    }),
  ].join("\n");
  assert.equal(
    parseClaudeStreamToolProof(badResultRole, { toolName: TOOL, nonce: NONCE }),
    null
  );
});

test("stream proof rejects duplicate tool_use ids", () => {
  const stream = [
    initEvent(),
    line({
      type: "assistant",
      session_id: SESSION,
      message: { content: [{ type: "tool_use", id: "tu-1", name: TOOL, input: {} }] },
    }),
    line({
      type: "assistant",
      session_id: SESSION,
      message: { content: [{ type: "tool_use", id: "tu-1", name: TOOL, input: {} }] },
    }),
    line({
      type: "user",
      session_id: SESSION,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu-1",
          content: `team-up-canary-ok:${NONCE}`,
        }],
      },
    }),
  ].join("\n");
  assert.equal(
    parseClaudeStreamToolProof(stream, { toolName: TOOL, nonce: NONCE }),
    null
  );
});

test("observeContextIsolation Claude expected keeps full four-type matrix", () => {
  const result = observeContextIsolation({
    adapter: {
      id: "claude",
      prepareLaunch: () => {
        throw new Error("stop-before-live");
      },
    },
    adapterId: "claude",
    cleanup: true,
    liveProbe: () => null,
  });
  assert.deepEqual(result.expected?.skills, ["capsule.selected-skill"]);
  assert.deepEqual(result.expected?.plugins, ["capsule.selected-plugin"]);
  assert.deepEqual(result.expected?.mcp_tools, ["mcp__selected__lookup"]);
  assert.deepEqual(result.expected?.frameworks, ["capsule.selected-framework"]);
  assert.ok(result.expected?.nonces?.skill);
  assert.ok(result.expected?.nonces?.plugin);
  assert.ok(result.expected?.nonces?.framework);
  assert.ok(result.expected?.nonces?.mcp);
  assert.equal(result.context_isolation, null);
});

test("observeContextIsolation Codex stays unverified with full expected (no empty-array grant)", () => {
  const result = observeContextIsolation({
    adapter: codexAdapter,
    adapterId: "codex",
    cleanup: true,
    liveProbe: () => ({
      skills: ["capsule.selected-skill"],
      plugins: [],
      mcp_tools: ["mcp__selected__lookup"],
      frameworks: [],
      absent: [...ISOLATION_FORBIDDEN_CANARIES],
      content_nonces: {
        skill: "x",
        plugin: "x",
        framework: "x",
        mcp: "x",
      },
    }),
  });
  assert.equal(result.context_isolation, null);
  assert.equal(result.isolation_status, "unverified");
  assert.equal(codexAdapter.capabilities.context_isolation, null);
});

test("MCP-only structured proof without live skill inventory does not grant v1", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const inventory = {
      skills: [],
      plugins: ["capsule.selected-plugin"],
      mcp_tools: ["mcp__selected__lookup"],
      frameworks: [],
      absent: [...ISOLATION_FORBIDDEN_CANARIES],
      // Omit skill/framework nonces — disk must not fill them.
      content_nonces: {
        plugin: fixture.expected.nonces.plugin,
        mcp: fixture.expected.nonces.mcp,
      },
    };
    const sessionId = "sess-mcp-only";
    const streamLines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        tools: ["Read", "ToolSearch", TOOL],
        mcp_servers: [{ name: "selected", status: "connected" }],
        skills: [],
        plugins: ["capsule.selected-plugin"],
        claude_code_version: "2.1.220",
      }),
      JSON.stringify({
        type: "assistant",
        session_id: sessionId,
        message: {
          content: [{ type: "tool_use", name: TOOL, id: "tu-1", input: {} }],
        },
      }),
      JSON.stringify({
        type: "user",
        session_id: sessionId,
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tu-1",
            content: `team-up-canary-ok:${fixture.expected.nonces.mcp}`,
          }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: sessionId,
        message: { content: [{ type: "text", text: JSON.stringify(inventory) }] },
      }),
    ];
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: buildHappySpawnSync(fixture, { inventory, streamLines }),
    });
    assert.equal(observed, null);
    assert.equal(
      decideContextIsolationCapability({
        expected: fixture.expected,
        observed: {
          skills: [],
          plugins: ["capsule.selected-plugin"],
          mcp_tools: ["mcp__selected__lookup"],
          frameworks: [],
          absent: [...ISOLATION_FORBIDDEN_CANARIES],
          content_nonces: {
            skill: fixture.expected.nonces.skill,
            plugin: fixture.expected.nonces.plugin,
            framework: fixture.expected.nonces.framework,
            mcp: fixture.expected.nonces.mcp,
          },
        },
      }),
      null
    );
  } finally {
    fixture.cleanup();
  }
});

test("guessed model content_nonces fail closed without disk/config nonce fill", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const inventory = buildHappyInventory(fixture);
    inventory.content_nonces = {
      skill: "guessed",
      plugin: "guessed",
      framework: "guessed",
      mcp: "guessed",
    };
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: buildHappySpawnSync(fixture, { inventory }),
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

test("Codex MCP-only JSONL without model skill inventory does not grant v1", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = codexAdapter.prepareLaunch({
      argv: ["codex", "exec", "probe"],
      runDir: fixture.runRoot,
      capsule: fixture.capsule,
      authSource: null,
    });
    const nonce = fixture.expected.nonces.mcp;
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread-mcp-only" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "mcp_tool_call",
          server: "selected",
          tool: "lookup",
          status: "completed",
          result: {
            content: [{ type: "text", text: `team-up-canary-ok:${nonce}` }],
          },
          error: null,
        },
      }),
      // No agent inventory message — disk must not invent skills/nonces.
    ].join("\n");
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "codex",
      spawnSyncFn: () => ({ status: 0, stdout: `${jsonl}\n`, stderr: "" }),
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

test("Claude second prepare wipes planted ambient skill from run home", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-claude-home-gen-"));
  try {
    const authHome = fs.mkdtempSync(path.join(os.tmpdir(), "tu-claude-auth-src-"));
    fs.mkdirSync(path.join(authHome, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(authHome, ".claude", ".credentials.json"), "{}\n");
    const first = materializeClaudeAuthHome(runDir, { authSourceHome: authHome });
    const planted = path.join(first.home || first, ".claude", "skills", "planted.skill");
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, "SKILL.md"), "# planted\n");
    const second = materializeClaudeAuthHome(runDir, { authSourceHome: authHome });
    const home = second.home || second;
    assert.equal(
      fs.existsSync(path.join(home, ".claude", "skills", "planted.skill")),
      false
    );
    assert.ok(second.generationId || second.home_generation);
    assert.notEqual(
      first.generationId || first.home_generation,
      second.generationId || second.home_generation
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("Codex second prepare wipes planted ambient skill from capsule home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-codex-home-gen-"));
  try {
    const capsuleHome = path.join(root, "run", "harness", "home");
    const skillSrc = path.join(root, "run", "context", "skills", "capsule.selected-skill");
    fs.mkdirSync(skillSrc, { recursive: true });
    fs.writeFileSync(path.join(skillSrc, "SKILL.md"), "# selected\n");
    const authSource = path.join(root, "auth.json");
    fs.writeFileSync(authSource, "{\"token\":\"t\"}\n");
    const capsule = {
      codexHome: capsuleHome,
      skillDirs: [path.join(root, "run", "context", "skills")],
      mcpConfig: { mcpServers: {} },
    };
    const first = codexAdapter.prepareLaunch({
      argv: ["codex", "exec", "a"],
      runDir: path.join(root, "run"),
      capsule,
      authSource,
    });
    fs.mkdirSync(path.join(capsuleHome, "skills", "planted.skill"), { recursive: true });
    fs.writeFileSync(path.join(capsuleHome, "skills", "planted.skill", "SKILL.md"), "# planted\n");
    const second = codexAdapter.prepareLaunch({
      argv: ["codex", "exec", "b"],
      runDir: path.join(root, "run"),
      capsule,
      authSource,
    });
    assert.equal(fs.existsSync(path.join(capsuleHome, "skills", "planted.skill")), false);
    assert.equal(fs.existsSync(path.join(capsuleHome, "skills", "capsule.selected-skill")), true);
    assert.ok(second.home_generation || second.generationId);
    assert.notEqual(
      first.home_generation || first.generationId,
      second.home_generation || second.generationId
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("closed-world binds MCP runtime scripts and rejects post-persist mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-mcp-runtime-"));
  try {
    const pkg = path.join(root, "pool", "fixture.mcp");
    const serverSrc = path.join(pkg, "mcps", "selected", "server.mjs");
    fs.mkdirSync(path.dirname(serverSrc), { recursive: true });
    fs.writeFileSync(serverSrc, "console.log('ok')\n");
    fs.writeFileSync(path.join(pkg, "mcps", "selected", "mcp.json"), JSON.stringify({
      tools: ["lookup"],
      mcpServers: {
        selected: {
          type: "stdio",
          command: process.execPath,
          args: [serverSrc],
          tools: ["lookup"],
        },
      },
    }, null, 2));
    fs.writeFileSync(path.join(pkg, "capability.json"), JSON.stringify({
      schema_version: 1,
      id: "fixture.mcp",
      version: "1.0.0",
      display_name: "fixture.mcp",
      provides: { skills: [], plugins: [], frameworks: [], mcps: ["mcps/selected/mcp.json"] },
      permissions: { network: false, commands: [], filesystem: "none" },
    }, null, 2));
    const runRoot = path.join(root, "run");
    fs.mkdirSync(runRoot, { recursive: true });
    const effective = materializeCapabilityCapsule({
      runRoot,
      specialistId: "fixture.mcp",
      packages: [{
        package: "fixture.mcp",
        id: "fixture.mcp",
        version: "1.0.0",
        checksum: "sha256:x",
        packageDir: pkg,
        reason: "selected",
        estimated_description_tokens: 1,
        mcp_tool_count: 1,
      }],
    });
    const mcpConfig = buildStrictMcpConfig(effective, runRoot);
    const runtimeArg = mcpConfig.mcpServers.selected.args[0];
    assert.ok(path.resolve(runtimeArg).startsWith(`${path.resolve(runRoot)}${path.sep}`));
    assert.notEqual(path.resolve(runtimeArg), path.resolve(serverSrc));
    const skillDir = path.join(runRoot, "context", "skills");
    const frameworkDir = path.join(runRoot, "context", "framework");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(frameworkDir, { recursive: true });
    const effectivePath = path.join(runRoot, "EFFECTIVE_CAPABILITIES.json");
    const manifest = buildCapsuleContentManifest({
      runRoot,
      skillDirs: [skillDir],
      pluginDirs: [],
      frameworkDirs: [frameworkDir],
      mcpConfig,
      effectivePath,
    });
    assert.ok(manifest.files.some((f) => f.path === path.resolve(runtimeArg)));
    fs.chmodSync(runtimeArg, 0o644);
    fs.appendFileSync(runtimeArg, "// mutated\n");
    assert.throws(
      () => verifyCapsuleContentManifest(manifest, {
        runRoot,
        skillDirs: [skillDir],
        pluginDirs: [],
        frameworkDirs: [frameworkDir],
      }),
      /CONTENT_MANIFEST_CHECKSUM/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listDirectoryNoFollow fails closed when /proc fd readdir unavailable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-nofollow-"));
  try {
    // Inject missing viaFd by using a custom dirPath that opens but cannot use /proc.
    // Implementation must reject path-based fallback for content-isolation v1.
    const prev = process.env.TEAM_UP_FORCE_NO_PROC_FD;
    process.env.TEAM_UP_FORCE_NO_PROC_FD = "1";
    try {
      assert.throws(
        () => listDirectoryNoFollow(dir),
        /CONTENT_MANIFEST_UNSUPPORTED_PLATFORM/
      );
    } finally {
      if (prev === undefined) delete process.env.TEAM_UP_FORCE_NO_PROC_FD;
      else process.env.TEAM_UP_FORCE_NO_PROC_FD = prev;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
