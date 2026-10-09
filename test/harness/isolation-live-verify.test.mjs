import "../helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { claudeAdapter } from "../../src/harness/claude.mjs";
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
  extractStructuredInitInventory,
  observeContextIsolation,
  validateIsolationObservation,
  ISOLATION_FORBIDDEN_CANARIES,
} from "../../src/harness/isolation-canary.mjs";
import { assertIsoFailure } from "../helpers/isolation-assert.mjs";

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
      writeSessionTranscript(home, sessionId, nonces.skill);
      return { status: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected: ${joined}` };
  };
}

/** The transcript claude keeps for the session: the user CLAUDE.md the probe planted and the selected skill body. */
function writeSessionTranscript(home, sessionId, skillNonce) {
  const dir = path.join(home, ".claude", "projects", "probe-cwd");
  fs.mkdirSync(dir, { recursive: true });
  const userMd = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "attachment", attachment: { type: "instructions", files: [{ type: "User", content: userMd }] } })}\n`
      + `${JSON.stringify({ type: "user", isMeta: true, message: { content: [{ type: "text", text: `nonce:${skillNonce}` }] } })}\n`
  );
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
  assertIsoFailure(parseClaudeStreamToolProof(stream, {
    toolName: "mcp__global__canary",
    nonce,
  }), "proof_incomplete");
  assertIsoFailure(parseClaudeStreamToolProof(stream, {
    toolName: "mcp__selected__lookup",
    nonce: "wrong-nonce",
  }), "tool_result_wrong_payload");
  assertIsoFailure(parseClaudeStreamToolProof("", { toolName: "x", nonce: "y" }), "no_stream_output");
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
    assertIsoFailure(observed, "inventory_no_stdout");
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
    assertIsoFailure(observed, "inventory_no_stdout");
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
    assertIsoFailure(observed, "inventory_no_stdout");
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
    assertIsoFailure(observed, "inventory_no_stdout");
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
    assertIsoFailure(observed, "forbidden_canary_present");
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
    assertIsoFailure(observed, "skill_proof_missing");

    // Wrong MCP structured nonce still fails closed even with otherwise-happy stream.
    // A fresh HOME: the first run left its session transcript in this one.
    const bad = collectLiveIsolationObservation({
      prepared: prepareClaudeLaunch(fixture),
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: buildHappySpawnSync(fixture, {
        inventory: buildHappyInventory(fixture),
        mcpNonce: "wrong-nonce",
      }),
    });
    assertIsoFailure(bad, "mcp_proof_missing");
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
    assertIsoFailure(observed, "init_inventory_missing");
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
    assertIsoFailure(observed, "init_inventory_missing");
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
    assertIsoFailure(decideContextIsolationCapability({ expected, observed }), "nonces_missing");
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
    assertIsoFailure(decideContextIsolationCapability({ expected, observed }), "absent_list_incomplete");
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
  assertIsoFailure(decideContextIsolationCapability({ expected, observed: null }), "observation_missing");
  assertIsoFailure(extractStructuredInitInventory("not-json"), "init_inventory_missing");
  assertIsoFailure(extractStructuredInitInventory("{"), "init_inventory_missing");
  assertIsoFailure(decideContextIsolationCapability({
      expected,
      observed: {
        skills: ["capsule.selected-skill"],
        plugins: [],
        mcp_tools: [],
        frameworks: [],
        absent: [],
      },
    }), "nonces_missing");
  assertIsoFailure(decideContextIsolationCapability({
      expected,
      observed: {
        skills: ["capsule.selected-skill"],
        plugins: ["capsule.selected-plugin"],
        mcp_tools: ["mcp__selected__lookup"],
        frameworks: ["capsule.selected-framework"],
        absent: ["global.canary-skill"],
        content_nonces: expected.nonces,
      },
    }), "absent_list_incomplete");
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
