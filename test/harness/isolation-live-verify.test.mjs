import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { claudeAdapter } from "../../src/harness/claude.mjs";
import { codexAdapter } from "../../src/harness/codex.mjs";
import { verifyHarness } from "../../src/harness/verify.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";
import {
  buildIsolationCanaryFixture,
  collectLaunchIsolationObservation,
  collectLiveIsolationObservation,
  decideContextIsolationCapability,
  detectClaudeUserMcpConfigFormat,
  executeConfiguredMcpCanaryTool,
  parseClaudeStreamToolProof,
  parseIsolationObservationJson,
  observeContextIsolation,
  validateIsolationObservation,
  ISOLATION_FORBIDDEN_CANARIES,
} from "../../src/harness/isolation-canary.mjs";

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
  const nonces = fixture.expected.nonces;
  const mcp = mcpNonce ?? nonces.mcp;
  const toolName = "mcp__selected__lookup";
  const sessionId = "sess-happy-1";
  const fwPath = path.join(
    fixture.capsule.frameworkDirs[0],
    "capsule.selected-framework",
    "framework.json"
  );
  const pluginCanary = "capsule.selected-plugin-canary";
  const lines = streamLines ?? [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      tools: ["Read", "Skill", "ToolSearch", toolName],
      mcp_servers: [{ name: "selected", status: "connected" }],
      skills: ["capsule.selected-skill", pluginCanary],
      plugins: ["capsule.selected-plugin"],
      claude_code_version: "2.1.220",
    }),
    JSON.stringify({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{
          type: "tool_use",
          name: "Skill",
          id: "tu-skill",
          input: { skill: "capsule.selected-skill" },
        }],
      },
    }),
    JSON.stringify({
      type: "user",
      session_id: sessionId,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu-skill",
          content: "Launching skill: capsule.selected-skill",
        }],
      },
    }),
    JSON.stringify({
      type: "user",
      session_id: sessionId,
      isSynthetic: true,
      message: {
        content: [{
          type: "text",
          text: `Base directory for this skill: /tmp/skills/capsule.selected-skill\n\n# capsule.selected-skill\nnonce:${nonces.skill}\n`,
        }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{
          type: "tool_use",
          name: "Skill",
          id: "tu-plugin",
          input: { skill: pluginCanary },
        }],
      },
    }),
    JSON.stringify({
      type: "user",
      session_id: sessionId,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu-plugin",
          content: `Launching skill: ${pluginCanary}`,
        }],
      },
    }),
    JSON.stringify({
      type: "user",
      session_id: sessionId,
      isSynthetic: true,
      message: {
        content: [{
          type: "text",
          text: `Base directory for this skill: /tmp/plugins/${pluginCanary}\n\n# ${pluginCanary}\nnonce:${nonces.plugin}\n`,
        }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          id: "tu-fw",
          input: { file_path: fwPath },
        }],
      },
    }),
    JSON.stringify({
      type: "user",
      session_id: sessionId,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu-fw",
          content: JSON.stringify({
            name: "capsule.selected-framework",
            content_nonce: nonces.framework,
          }),
        }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "tool_use", name: toolName, id: "tu-mcp", input: {} }],
      },
    }),
    JSON.stringify({
      type: "user",
      session_id: sessionId,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu-mcp",
          content: `team-up-canary-ok:${mcp}`,
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
  return (cmd, args, opts) => {
    const joined = [cmd, ...(args || [])].join(" ");
    const home = opts?.env?.HOME || "";
    if (joined.includes("mcp list")) {
      if (home.includes("tu-claude-json-home")) {
        return { status: 0, stdout: "format-probe-claude: ok\n", stderr: "" };
      }
      if (home.includes("tu-mcp-json-home")) {
        return { status: 0, stdout: "No MCP servers configured\n", stderr: "" };
      }
      if (joined.includes("--bare")) {
        return {
          status: 0,
          stdout: "Checking MCP server health…\n\nselected: node canary - ✔ Connected\n",
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: "Checking MCP server health…\n\nglobal: node canary - ✔ Connected\n",
        stderr: "",
      };
    }
    if (joined.includes("plugin list")) {
      return {
        status: 0,
        stdout: "Session-only plugins\n❯ capsule.selected-plugin@local\n",
        stderr: "",
      };
    }
    if (joined.includes("stream-json") || joined.includes("isolation canary")) {
      return { status: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected: ${joined}` };
  };
}

test("canary fixture exposes selected set, nonces, and .claude.json global MCP", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    assert.deepEqual(fixture.expected.skills, ["capsule.selected-skill"]);
    assert.deepEqual(fixture.expected.plugins, ["capsule.selected-plugin"]);
    assert.deepEqual(fixture.expected.mcp_tools, ["mcp__selected__lookup"]);
    assert.deepEqual(fixture.expected.frameworks, ["capsule.selected-framework"]);
    assert.ok(fixture.expected.nonces?.skill);
    assert.ok(fixture.expected.nonces?.plugin);
    assert.ok(fixture.expected.nonces?.framework);
    assert.ok(fixture.expected.nonces?.mcp);
    assert.equal(fixture.codexExpected, null);
    const claudeJson = JSON.parse(
      fs.readFileSync(path.join(fixture.globalHome, ".claude.json"), "utf8")
    );
    assert.ok(claudeJson.mcpServers?.global);
    assert.equal(
      fs.existsSync(path.join(fixture.runRoot, "context", "skills", "capsule.selected-skill")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(fixture.runRoot, "context", "skills", "pool.unselected-skill")),
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test("selected MCP canary tool executes successfully (diagnostics only)", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const server = fixture.capsule.mcpConfig.mcpServers.selected;
    const result = executeConfiguredMcpCanaryTool(server, {
      spawnSyncFn: spawnSync,
      toolName: "lookup",
      expectedText: `team-up-canary-ok:${fixture.expected.nonces.mcp}`,
    });
    assert.ok(result);
    assert.equal(result.tool, "lookup");
  } finally {
    fixture.cleanup();
  }
});

test("parseClaudeStreamToolProof requires exact tool and nonce", () => {
  const nonce = "tu-nonce-deadbeef";
  const sessionId = "sess-unit-1";
  const stream = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      tools: ["mcp__selected__lookup"],
      mcp_servers: [{ name: "selected" }],
    }),
    JSON.stringify({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "tool_use", name: "mcp__selected__lookup", id: "1" }],
      },
    }),
    JSON.stringify({
      type: "user",
      session_id: sessionId,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "1",
          content: `team-up-canary-ok:${nonce}`,
        }],
      },
    }),
  ].join("\n");
  assert.ok(parseClaudeStreamToolProof(stream, {
    toolName: "mcp__selected__lookup",
    nonce,
  }));
  assert.equal(parseClaudeStreamToolProof(stream, {
    toolName: "mcp__global__canary",
    nonce,
  }), null);
  assert.equal(parseClaudeStreamToolProof(stream, {
    toolName: "mcp__selected__lookup",
    nonce: "wrong-nonce",
  }), null);
  assert.equal(parseClaudeStreamToolProof("", { toolName: "x", nonce: "y" }), null);
});

test("launch-surface observation alone does not grant isolation without live probe", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const surface = collectLaunchIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      adapterId: "claude",
    });
    assert.ok(surface);
    const result = observeContextIsolation({
      adapter: claudeAdapter,
      adapterId: "claude",
      spawnSyncFn: null,
      liveProbe: null,
    });
    assert.equal(result.context_isolation, null);
    assert.match(result.error || "", /missing|skipped|malformed/i);
  } finally {
    fixture.cleanup();
  }
});

test("disk or config-only Claude observation does not grant isolation token", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: (cmd, args) => {
        const joined = [cmd, ...(args || [])].join(" ");
        if (joined.includes("plugin list")) {
          return {
            status: 0,
            stdout: "Session-only plugins\n❯ capsule.selected-plugin@local\n",
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: "skip" };
      },
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

test("Node MCP preflight alone does not satisfy live model proof", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: (cmd, args, opts) => {
        const joined = [cmd, ...(args || [])].join(" ");
        if (joined.includes("-e") && String(args?.[0]) === "-e") {
          return spawnSync(cmd, args, opts);
        }
        if (joined.includes("mcp list") && !joined.includes("--bare")) {
          return {
            status: 0,
            stdout: "global: node canary - ✔ Connected\n",
            stderr: "",
          };
        }
        if (joined.includes("mcp list") && joined.includes("--bare")) {
          return { status: 0, stdout: "selected: node canary\n", stderr: "" };
        }
        if (joined.includes("plugin list")) {
          return {
            status: 0,
            stdout: "Session-only plugins\n❯ capsule.selected-plugin@local\n",
            stderr: "",
          };
        }
        // No stream-json model turn — must fail
        return { status: 1, stdout: "", stderr: "no model" };
      },
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

test("exact live Claude observation grants isolation capability token", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: buildHappySpawnSync(fixture),
    });
    assert.ok(observed, "live observation should succeed with full harness probes");
    assert.deepEqual(observed.content_nonces, fixture.expected.nonces);
    assert.equal(
      decideContextIsolationCapability({ expected: fixture.expected, observed }),
      CONTEXT_ISOLATION_CAPABILITY
    );
  } finally {
    fixture.cleanup();
  }
});

test("global MCP positive control requires neutral-cwd claude mcp list visibility", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: (cmd, args) => {
        const joined = [cmd, ...(args || [])].join(" ");
        if (joined.includes("mcp list") && !joined.includes("--bare")) {
          return { status: 0, stdout: "No MCP servers configured\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

test("isolated negative control requires global absent under bare strict mcp list", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: (cmd, args) => {
        const joined = [cmd, ...(args || [])].join(" ");
        if (joined.includes("mcp list") && !joined.includes("--bare")) {
          return { status: 0, stdout: "global: node canary\n", stderr: "" };
        }
        if (joined.includes("mcp list") && joined.includes("--bare")) {
          // Leak: global still visible under isolated launch
          return { status: 0, stdout: "global: node canary\nselected: node\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: correct names but empty model absent still derives structured absents", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const inventory = buildHappyInventory(fixture);
    inventory.absent = [];
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: buildHappySpawnSync(fixture, { inventory }),
    });
    // Model-authored empty absent is ignored; structured init supplies negatives.
    assert.ok(observed);
    assert.ok(observed.absent.includes("global.canary-skill"));
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: structured init listing a forbidden plugin fails closed", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const inventory = buildHappyInventory(fixture);
    const nonce = fixture.expected.nonces.mcp;
    const sessionId = "sess-leak-1";
    const streamLines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        tools: ["Read", "ToolSearch", "mcp__selected__lookup"],
        mcp_servers: [{ name: "selected", status: "connected" }],
        skills: ["capsule.selected-skill"],
        plugins: ["capsule.selected-plugin", "global.canary-plugin"],
        claude_code_version: "2.1.220",
      }),
      JSON.stringify({
        type: "assistant",
        session_id: sessionId,
        message: {
          content: [{ type: "tool_use", name: "mcp__selected__lookup", id: "tu-1", input: {} }],
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
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: guessed final JSON without structured Skill/plugin/Read proofs fails closed", () => {
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
    const sessionId = "sess-guess-only";
    const nonce = fixture.expected.nonces.mcp;
    // MCP proof alone + guessed JSON inventory is not a full matrix grant.
    const streamLines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        tools: ["Read", "Skill", "ToolSearch", "mcp__selected__lookup"],
        mcp_servers: [{ name: "selected", status: "connected" }],
        skills: ["capsule.selected-skill"],
        plugins: ["capsule.selected-plugin"],
        claude_code_version: "2.1.220",
      }),
      JSON.stringify({
        type: "assistant",
        session_id: sessionId,
        message: {
          content: [{
            type: "tool_use",
            name: "mcp__selected__lookup",
            id: "tu-1",
            input: {},
          }],
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

    // Wrong MCP structured nonce still fails closed even with otherwise-happy stream.
    const bad = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: buildHappySpawnSync(fixture, {
        inventory: buildHappyInventory(fixture),
        mcpNonce: "wrong-nonce",
      }),
    });
    assert.equal(bad, null);
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: no tool_use in stream fails closed", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const inventory = buildHappyInventory(fixture);
    const streamLines = [
      JSON.stringify({
        type: "assistant",
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
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: wrong tool or result nonce fails closed", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const inventory = buildHappyInventory(fixture);
    const streamLines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "mcp__global__canary", id: "1" }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "1", content: "wrong" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
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
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: structural-only report without content_nonces fails closed", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const expected = fixture.expected;
    const observed = {
      skills: expected.skills,
      plugins: expected.plugins,
      mcp_tools: expected.mcp_tools,
      frameworks: expected.frameworks,
      absent: [...ISOLATION_FORBIDDEN_CANARIES],
    };
    assert.equal(
      decideContextIsolationCapability({ expected, observed }),
      null
    );
    const validation = validateIsolationObservation({ expected, observed });
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => /content_nonces/.test(e)));
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: partial absent list fails closed without repair", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const expected = fixture.expected;
    const observed = {
      skills: expected.skills,
      plugins: expected.plugins,
      mcp_tools: expected.mcp_tools,
      frameworks: expected.frameworks,
      absent: ["global.canary-skill"],
      content_nonces: { ...expected.nonces },
    };
    assert.equal(
      decideContextIsolationCapability({ expected, observed }),
      null
    );
  } finally {
    fixture.cleanup();
  }
});

test("detectClaudeUserMcpConfigFormat returns claude.json when probe confirms", () => {
  const format = detectClaudeUserMcpConfigFormat({
    spawnSyncFn: (cmd, args, opts) => {
      const joined = [cmd, ...(args || [])].join(" ");
      const home = opts?.env?.HOME || "";
      if (!joined.includes("mcp list")) {
        return { status: 1, stdout: "", stderr: "fail" };
      }
      if (home.includes("tu-claude-json-home")) {
        return { status: 0, stdout: "format-probe-claude: ok\n", stderr: "" };
      }
      if (home.includes("tu-mcp-json-home")) {
        return { status: 0, stdout: "No MCP servers configured\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "fail" };
    },
  });
  assert.equal(format, "claude.json");
});

test("detectClaudeUserMcpConfigFormat fails closed on format uncertainty", () => {
  const format = detectClaudeUserMcpConfigFormat({
    spawnSyncFn: () => ({
      status: 0,
      stdout: "format-probe-claude: ok\nformat-probe-mcp: ok\n",
      stderr: "",
    }),
  });
  assert.equal(format, null);
});

test("skipped live probe fails closed with null isolation token", () => {
  const result = observeContextIsolation({
    adapter: claudeAdapter,
    adapterId: "claude",
    spawnSyncFn: spawnSync,
    liveProbe: () => null,
  });
  assert.equal(result.context_isolation, null);
  assert.match(result.error || "", /skipped|incomplete/i);
});

test("malformed skipped or partial observation withholds isolation token", () => {
  const expected = {
    skills: ["capsule.selected-skill"],
    plugins: ["capsule.selected-plugin"],
    mcp_tools: ["mcp__selected__lookup"],
    frameworks: ["capsule.selected-framework"],
    nonces: {
      skill: "s1",
      plugin: "p1",
      framework: "f1",
      mcp: "m1",
    },
  };
  assert.equal(decideContextIsolationCapability({ expected, observed: null }), null);
  assert.equal(parseIsolationObservationJson("not-json"), null);
  assert.equal(parseIsolationObservationJson("{"), null);
  assert.equal(
    decideContextIsolationCapability({
      expected,
      observed: parseIsolationObservationJson(JSON.stringify({
        skills: ["capsule.selected-skill"],
      })),
    }),
    null
  );
  assert.equal(
    decideContextIsolationCapability({
      expected,
      observed: {
        skills: ["capsule.selected-skill"],
        plugins: ["capsule.selected-plugin"],
        mcp_tools: ["mcp__selected__lookup"],
        frameworks: ["capsule.selected-framework"],
        absent: ["global.canary-skill"],
        content_nonces: expected.nonces,
      },
    }),
    null
  );
});

test("verifyHarness stores context_isolation only on exact runner token", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-verify-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  try {
    const brokerOnly = await verifyHarness({
      adapter: claudeAdapter,
      fixtureProject: "/tmp",
      env,
      runner: Object.assign(
        async () => ({
          native_shell: "denied",
          broker_tool: "passed",
        }),
        { execFileSync: () => "claude 3.3.3\n" }
      ),
    });
    // Claude declares context_isolation — broker alone must not verify.
    assert.equal(brokerOnly.status, "unverified");
    assert.equal(brokerOnly.context_isolation, null);

    const withIsolation = await verifyHarness({
      adapter: {
        ...claudeAdapter,
        version: () => "3.3.4",
      },
      fixtureProject: "/tmp",
      env,
      runner: Object.assign(
        async () => ({
          native_shell: "denied",
          broker_tool: "passed",
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
        }),
        { execFileSync: () => "3.3.4" }
      ),
    });
    assert.equal(withIsolation.status, "verified");
    assert.equal(withIsolation.context_isolation, CONTEXT_ISOLATION_CAPABILITY);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Codex live canary cannot grant generic v1 without plugin/framework surfaces", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = codexAdapter.prepareLaunch({
      argv: ["codex", "exec", "probe"],
      runDir: fixture.runRoot,
      capsule: fixture.capsule,
      authSource: null,
    });
    assert.equal(codexAdapter.capabilities.context_isolation, null);

    const incomplete = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "codex",
      spawnSyncFn: () => ({ status: 0, stdout: '{"type":"thread.started"}\n', stderr: "" }),
    });
    assert.equal(incomplete, null);

    const nonce = fixture.expected.nonces.mcp;
    const happyJsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_0",
          type: "mcp_tool_call",
          server: "selected",
          tool: "lookup",
          status: "in_progress",
        },
      }),
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
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify(buildHappyInventory(fixture)),
        },
      }),
    ].join("\n");
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "codex",
      spawnSyncFn: () => ({ status: 0, stdout: `${happyJsonl}\n`, stderr: "" }),
    });
    // Full expected matrix includes plugins/frameworks Codex cannot natively prove.
    assert.equal(observed, null);
    assert.equal(prepared.env.CODEX_HOME, fixture.capsule.codexHome);
  } finally {
    fixture.cleanup();
  }
});

test("verifyHarness codex path verifies from isolation without broker", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-codex-verify-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  try {
    const unverified = await verifyHarness({
      adapter: codexAdapter,
      fixtureProject: "/tmp",
      env,
      runner: Object.assign(
        async () => ({
          native_shell: "unverified",
          broker_tool: "unverified",
          isolation_status: "unverified",
          error: "codex auth unavailable",
        }),
        { execFileSync: () => "codex-cli 0.145.0\n" }
      ),
    });
    assert.equal(unverified.status, "unverified");
    assert.equal(unverified.context_isolation, null);
    assert.equal(unverified.command_broker, null);

    const verified = await verifyHarness({
      adapter: {
        ...codexAdapter,
        version: () => "0.145.1",
      },
      fixtureProject: "/tmp",
      env,
      runner: Object.assign(
        async () => ({
          native_shell: "unverified",
          broker_tool: "unverified",
          isolation_status: "passed",
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
        }),
        { execFileSync: () => "0.145.1" }
      ),
    });
    // Declared context_isolation is null — runner cannot mint the token.
    assert.equal(verified.status, "unverified");
    assert.equal(verified.context_isolation, null);
    assert.equal(verified.command_broker, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runHarnessVerify codex never reports adapter not ready", async () => {
  const { runHarnessVerify } = await import("../../src/harness/cli-verify.mjs");
  const fixtureProject = fs.mkdtempSync(path.join(os.tmpdir(), "tu-codex-cli-"));
  const err = [];
  const out = [];
  const code = await runHarnessVerify(
    ["codex", "--fixture-project", fixtureProject],
    {
      out: (line) => out.push(String(line)),
      err: (line) => err.push(String(line)),
      runners: {
        codex: Object.assign(
          async () => ({
            native_shell: "unverified",
            broker_tool: "unverified",
            isolation_status: "unverified",
            error: "codex executable unavailable in test",
          }),
          { execFileSync: () => "codex-cli 0.145.0\n" }
        ),
      },
      env: { ...process.env, TEAM_UP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-")) },
    }
  );
  fs.rmSync(fixtureProject, { recursive: true, force: true });
  assert.notEqual(code, 1);
  assert.equal(err.some((e) => /not ready/i.test(e)), false);
  assert.equal(out.some((l) => /status:\s*unverified/.test(l)), true);
});
