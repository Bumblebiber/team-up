import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAdapter } from "../../src/harness/claude.mjs";
import { codexAdapter } from "../../src/harness/codex.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";
import {
  buildIsolationCanaryFixture,
  collectLaunchIsolationObservation,
  collectLiveIsolationObservation,
  decideContextIsolationCapability,
  observeContextIsolation,
  parseClaudeStructuredCapabilityProofs,
  validateIsolationObservation,
  PLUGIN_CANARY_SKILL,
  ISOLATION_FORBIDDEN_CANARIES,
} from "../../src/harness/isolation-canary.mjs";

const SESSION = "sess-grant-guards";

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

function frameworkPath(fixture) {
  return path.join(
    fixture.capsule.frameworkDirs[0],
    "capsule.selected-framework",
    "framework.json"
  );
}

function buildHappySpawnSync(fixture, { streamLines } = {}) {
  const nonces = fixture.expected.nonces;
  const toolName = "mcp__selected__lookup";
  const fwPath = frameworkPath(fixture);
  const pluginCanary = PLUGIN_CANARY_SKILL;
  const lines = streamLines ?? [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: SESSION,
      tools: ["Read", "Skill", "ToolSearch", toolName],
      mcp_servers: [{ name: "selected", status: "connected" }],
      skills: ["capsule.selected-skill", pluginCanary],
      plugins: ["capsule.selected-plugin"],
      claude_code_version: "2.1.220",
    }),
    JSON.stringify({
      type: "assistant",
      session_id: SESSION,
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
      session_id: SESSION,
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
      session_id: SESSION,
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
      session_id: SESSION,
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
      session_id: SESSION,
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
      session_id: SESSION,
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
      session_id: SESSION,
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
      session_id: SESSION,
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
      session_id: SESSION,
      message: {
        content: [{ type: "tool_use", name: toolName, id: "tu-mcp", input: {} }],
      },
    }),
    JSON.stringify({
      type: "user",
      session_id: SESSION,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu-mcp",
          content: `team-up-canary-ok:${nonces.mcp}`,
        }],
      },
    }),
  ];
  return () => ({ status: 0, stdout: `${lines.join("\n")}\n`, stderr: "" });
}

function proofsWithoutMcp(fixture) {
  const nonces = fixture.expected.nonces;
  const fwPath = frameworkPath(fixture);
  const pluginCanary = PLUGIN_CANARY_SKILL;
  return [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: SESSION,
      tools: ["Read", "Skill", "ToolSearch", "mcp__selected__lookup"],
      mcp_servers: [{ name: "selected", status: "connected" }],
      skills: ["capsule.selected-skill", pluginCanary],
      plugins: ["capsule.selected-plugin"],
      claude_code_version: "2.1.220",
    }),
    JSON.stringify({
      type: "assistant",
      session_id: SESSION,
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
      session_id: SESSION,
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
      session_id: SESSION,
      isSynthetic: true,
      message: {
        content: [{
          type: "text",
          text: `Base directory for this skill: /x\nnonce:${nonces.skill}\n`,
        }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      session_id: SESSION,
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
      session_id: SESSION,
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
      session_id: SESSION,
      isSynthetic: true,
      message: {
        content: [{
          type: "text",
          text: `Base directory for this skill: /x\nnonce:${nonces.plugin}\n`,
        }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      session_id: SESSION,
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
      session_id: SESSION,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu-fw",
          content: JSON.stringify({ content_nonce: nonces.framework }),
        }],
      },
    }),
  ];
}

// M3 — validate: drop nonce equality
test("decide denies when content_nonces disagree with expected", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const observed = {
      ...buildHappyInventory(fixture),
      content_nonces: {
        ...fixture.expected.nonces,
        mcp: "tampered-nonce",
      },
    };
    assert.equal(
      decideContextIsolationCapability({ expected: fixture.expected, observed }),
      null
    );
    const validation = validateIsolationObservation({
      expected: fixture.expected,
      observed,
    });
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => /content_nonces\.mcp/.test(e)));
  } finally {
    fixture.cleanup();
  }
});

// M21 — decide: drop array-shape gate
test("decide denies when observed matrix fields are not arrays", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const base = buildHappyInventory(fixture);
    assert.equal(
      decideContextIsolationCapability({
        expected: fixture.expected,
        observed: { ...base, skills: "not-an-array" },
      }),
      null
    );
    assert.equal(
      decideContextIsolationCapability({
        expected: fixture.expected,
        observed: { ...base, absent: null },
      }),
      null
    );
  } finally {
    fixture.cleanup();
  }
});

// M15 — structured proofs: skip mcp proof
test("structured proof without MCP invocation does not grant", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const stream = proofsWithoutMcp(fixture).join("\n");
    assert.equal(
      parseClaudeStructuredCapabilityProofs(stream, {
        expected: fixture.expected,
        capsule: fixture.capsule,
        prepared,
      }),
      null
    );
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: buildHappySpawnSync(fixture, { streamLines: proofsWithoutMcp(fixture) }),
    });
    assert.equal(observed, null);
    assert.equal(
      decideContextIsolationCapability({ expected: fixture.expected, observed }),
      null
    );
  } finally {
    fixture.cleanup();
  }
});

// M17 — structured proofs: drop init skill/plugin requirement
test("parseClaudeStructuredCapabilityProofs denies when init omits selected skill", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const streamLines = proofsWithoutMcp(fixture);
    const init = JSON.parse(streamLines[0]);
    init.skills = [PLUGIN_CANARY_SKILL];
    streamLines[0] = JSON.stringify(init);
    streamLines.push(
      JSON.stringify({
        type: "assistant",
        session_id: SESSION,
        message: {
          content: [{
            type: "tool_use",
            name: "mcp__selected__lookup",
            id: "tu-mcp",
            input: {},
          }],
        },
      }),
      JSON.stringify({
        type: "user",
        session_id: SESSION,
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tu-mcp",
            content: `team-up-canary-ok:${fixture.expected.nonces.mcp}`,
          }],
        },
      })
    );
    const stream = streamLines.join("\n");
    assert.equal(
      parseClaudeStructuredCapabilityProofs(stream, {
        expected: fixture.expected,
        capsule: fixture.capsule,
        prepared,
      }),
      null
    );
  } finally {
    fixture.cleanup();
  }
});

test("parseClaudeStructuredCapabilityProofs denies when init omits selected plugin", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const streamLines = proofsWithoutMcp(fixture);
    const init = JSON.parse(streamLines[0]);
    init.plugins = [];
    streamLines[0] = JSON.stringify(init);
    streamLines.push(
      JSON.stringify({
        type: "assistant",
        session_id: SESSION,
        message: {
          content: [{
            type: "tool_use",
            name: "mcp__selected__lookup",
            id: "tu-mcp",
            input: {},
          }],
        },
      }),
      JSON.stringify({
        type: "user",
        session_id: SESSION,
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tu-mcp",
            content: `team-up-canary-ok:${fixture.expected.nonces.mcp}`,
          }],
        },
      })
    );
    const stream = streamLines.join("\n");
    assert.equal(
      parseClaudeStructuredCapabilityProofs(stream, {
        expected: fixture.expected,
        capsule: fixture.capsule,
        prepared,
      }),
      null
    );
  } finally {
    fixture.cleanup();
  }
});

// M18 — structured proofs: drop verifyInitSurfaceExclusion
test("parseClaudeStructuredCapabilityProofs denies unselected skill in init inventory", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const streamLines = proofsWithoutMcp(fixture);
    const init = JSON.parse(streamLines[0]);
    init.skills = ["capsule.selected-skill", PLUGIN_CANARY_SKILL, "o9k-scout"];
    streamLines[0] = JSON.stringify(init);
    streamLines.push(
      JSON.stringify({
        type: "assistant",
        session_id: SESSION,
        message: {
          content: [{
            type: "tool_use",
            name: "mcp__selected__lookup",
            id: "tu-mcp",
            input: {},
          }],
        },
      }),
      JSON.stringify({
        type: "user",
        session_id: SESSION,
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tu-mcp",
            content: `team-up-canary-ok:${fixture.expected.nonces.mcp}`,
          }],
        },
      })
    );
    const stream = streamLines.join("\n");
    assert.equal(
      parseClaudeStructuredCapabilityProofs(stream, {
        expected: fixture.expected,
        capsule: fixture.capsule,
        prepared,
      }),
      null
    );
  } finally {
    fixture.cleanup();
  }
});

// M23 — observe: liveProbe stream re-proof dropped
test("observeContextIsolation liveProbe without stream_text does not grant", async () => {
  const { observeContextIsolation } = await import("../../src/harness/isolation-canary.mjs");
  const fixture = buildIsolationCanaryFixture();
  try {
    const result = observeContextIsolation({
      adapter: claudeAdapter,
      adapterId: "claude",
      cleanup: false,
      liveProbe: () => ({
        observed: buildHappyInventory(fixture),
      }),
    });
    assert.equal(result.context_isolation, null);
    assert.match(result.error || "", /stream_text|re-proof/i);
  } finally {
    fixture.cleanup();
  }
});

// M26 — live: drop probeHome closed-world check (covered in review8; pin parse layer too)
test("parseClaudeStructuredCapabilityProofs is unaffected by probe HOME leaks", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const leakRoot = path.join(prepared.env.HOME, ".claude", "skills");
    fs.mkdirSync(path.join(leakRoot, "o9k-scout"), { recursive: true });
    fs.writeFileSync(path.join(leakRoot, "o9k-scout", "SKILL.md"), "# leak\n");
    const stream = [
      ...proofsWithoutMcp(fixture),
      JSON.stringify({
        type: "assistant",
        session_id: SESSION,
        message: {
          content: [{
            type: "tool_use",
            name: "mcp__selected__lookup",
            id: "tu-mcp",
            input: {},
          }],
        },
      }),
      JSON.stringify({
        type: "user",
        session_id: SESSION,
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tu-mcp",
            content: `team-up-canary-ok:${fixture.expected.nonces.mcp}`,
          }],
        },
      }),
    ].join("\n");
    assert.ok(
      parseClaudeStructuredCapabilityProofs(stream, {
        expected: fixture.expected,
        capsule: fixture.capsule,
        prepared,
      })
    );
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: () => ({ status: 0, stdout: `${stream}\n`, stderr: "" }),
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

test("observeContextIsolation codex never grants even with forged liveProbe", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const stream = buildHappySpawnSync(fixture)().stdout;
    const result = observeContextIsolation({
      adapter: codexAdapter,
      adapterId: "codex",
      cleanup: false,
      liveProbe: () => ({
        stream_text: stream,
        observed: buildHappyInventory(fixture),
      }),
    });
    assert.equal(result.context_isolation, null);
    assert.notEqual(result.isolation_status, "passed");
  } finally {
    fixture.cleanup();
  }
});

// M27 — live: drop --strict-mcp-config requirement
test("live observation requires --strict-mcp-config on prepared argv", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    prepared.argv = prepared.argv.filter((arg) => arg !== "--strict-mcp-config");
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: buildHappySpawnSync(fixture),
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

// M28 — live: drop stdout requirement
test("live observation rejects stderr-only inventory output", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: () => ({
        status: 0,
        stdout: "",
        stderr: '{"type":"system","subtype":"init"}\n',
      }),
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

// M29 — live: drop structured-init requirement
test("live observation rejects stream with no system/init", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: () => ({
        status: 0,
        stdout: '{"type":"assistant","message":{"content":[]}}\n',
        stderr: "",
      }),
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

// M35 — live: drop init negative gates
test("live observation denies when init lists global.canary-skill", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const streamLines = proofsWithoutMcp(fixture);
    const init = JSON.parse(streamLines[0]);
    init.skills = ["capsule.selected-skill", PLUGIN_CANARY_SKILL, "global.canary-skill"];
    streamLines[0] = JSON.stringify(init);
    streamLines.push(
      JSON.stringify({
        type: "assistant",
        session_id: SESSION,
        message: {
          content: [{
            type: "tool_use",
            name: "mcp__selected__lookup",
            id: "tu-mcp",
            input: {},
          }],
        },
      }),
      JSON.stringify({
        type: "user",
        session_id: SESSION,
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tu-mcp",
            content: `team-up-canary-ok:${fixture.expected.nonces.mcp}`,
          }],
        },
      })
    );
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: buildHappySpawnSync(fixture, { streamLines }),
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

// M38 — live: drop globalsPlanted precondition
test("live observation requires planted global canary fixture home", () => {
  const fixture = buildIsolationCanaryFixture();
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "tu-empty-global-"));
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: emptyHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: buildHappySpawnSync(fixture),
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});

// M39 — launch surface: forbidden canaries never marked present
test("launch surface omits visible forbidden canaries from absent list", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const leak = path.join(fixture.capsule.skillDirs[0], "global.canary-skill");
    fs.mkdirSync(leak, { recursive: true });
    fs.writeFileSync(path.join(leak, "SKILL.md"), "# leaked global canary\n");
    const surface = collectLaunchIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      adapterId: "claude",
    });
    assert.ok(surface);
    assert.ok(surface.skills.includes("global.canary-skill"));
    assert.ok(!surface.absent.includes("global.canary-skill"));
    assert.equal(
      decideContextIsolationCapability({
        expected: fixture.expected,
        observed: {
          ...buildHappyInventory(fixture),
          skills: [...fixture.expected.skills, "global.canary-skill"],
        },
      }),
      null
    );
  } finally {
    fixture.cleanup();
  }
});

// Control: happy path still grants through production collector
test("grant decision guards control path still grants with full proofs", () => {
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
    assert.ok(observed);
    assert.equal(
      decideContextIsolationCapability({ expected: fixture.expected, observed }),
      CONTEXT_ISOLATION_CAPABILITY
    );
  } finally {
    fixture.cleanup();
  }
});
