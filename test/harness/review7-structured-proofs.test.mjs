import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAdapter } from "../../src/harness/claude.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";
import {
  buildIsolationCanaryFixture,
  collectLiveIsolationObservation,
  decideContextIsolationCapability,
  parseClaudeStructuredCapabilityProofs,
  PLUGIN_CANARY_SKILL,
  ISOLATION_FORBIDDEN_CANARIES,
} from "../../src/harness/isolation-canary.mjs";

const SESSION = "sess-struct-220";

function line(obj) {
  return JSON.stringify(obj);
}

function initEvent(overrides = {}) {
  return line({
    type: "system",
    subtype: "init",
    session_id: SESSION,
    tools: ["Read", "Skill", "ToolSearch", "mcp__selected__lookup"],
    mcp_servers: [{ name: "selected", status: "connected" }],
    skills: ["capsule.selected-skill", PLUGIN_CANARY_SKILL],
    plugins: ["capsule.selected-plugin"],
    claude_code_version: "2.1.220",
    ...overrides,
  });
}

function assistantUse(id, name, input) {
  return line({
    type: "assistant",
    session_id: SESSION,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
}

function userResult(id, content) {
  return line({
    type: "user",
    session_id: SESSION,
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
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

function frameworkPath(fixture) {
  return path.join(
    fixture.capsule.frameworkDirs[0],
    "capsule.selected-framework",
    "framework.json"
  );
}

function fullStructuredStream(fixture, {
  skillNonce,
  pluginNonce,
  frameworkNonce,
  mcpNonce,
  frameworkFilePath,
} = {}) {
  const sn = skillNonce ?? fixture.expected.nonces.skill;
  const pn = pluginNonce ?? fixture.expected.nonces.plugin;
  const fn = frameworkNonce ?? fixture.expected.nonces.framework;
  const mn = mcpNonce ?? fixture.expected.nonces.mcp;
  const fwPath = frameworkFilePath ?? frameworkPath(fixture);
  return [
    initEvent(),
    assistantUse("tu-skill", "Skill", { skill: "capsule.selected-skill" }),
    userResult("tu-skill", "Launching skill: capsule.selected-skill"),
    line({
      type: "user",
      session_id: SESSION,
      isSynthetic: true,
      message: {
        content: [{
          type: "text",
          text: `Base directory for this skill: /tmp/skills/capsule.selected-skill\n\n# capsule.selected-skill\ncanary skill\nnonce:${sn}\n`,
        }],
      },
    }),
    assistantUse("tu-plugin", "Skill", { skill: PLUGIN_CANARY_SKILL }),
    userResult("tu-plugin", `Launching skill: ${PLUGIN_CANARY_SKILL}`),
    line({
      type: "user",
      session_id: SESSION,
      isSynthetic: true,
      message: {
        content: [{
          type: "text",
          text: `Base directory for this skill: /tmp/plugins/capsule.selected-plugin/skills/${PLUGIN_CANARY_SKILL}\n\n# ${PLUGIN_CANARY_SKILL}\nplugin canary skill\nnonce:${pn}\n`,
        }],
      },
    }),
    assistantUse("tu-fw", "Read", { file_path: fwPath }),
    userResult(
      "tu-fw",
      JSON.stringify({
        name: "capsule.selected-framework",
        content_nonce: fn,
      }, null, 2)
    ),
    assistantUse("tu-mcp", "mcp__selected__lookup", {}),
    userResult("tu-mcp", `team-up-canary-ok:${mn}`),
    // Final JSON claims empty — must be ignored when structured proofs exist.
    line({
      type: "assistant",
      session_id: SESSION,
      message: {
        content: [{
          type: "text",
          text: JSON.stringify({
            skills: [],
            plugins: [],
            mcp_tools: [],
            frameworks: [],
            absent: [...ISOLATION_FORBIDDEN_CANARIES],
            content_nonces: {
              skill: "guessed",
              plugin: "guessed",
              framework: "guessed",
              mcp: "guessed",
            },
          }),
        }],
      },
    }),
  ].join("\n");
}

test("claude allowed tools include Skill", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-skill-allow-"));
  try {
    const prepared = claudeAdapter.prepareLaunch({
      argv: ["claude", "-p", "x"],
      runDir,
      capsule: {
        pluginDirs: [`${runDir}/harness/plugins/x`],
        skillDirs: [],
        frameworkDirs: [],
        mcpConfig: { mcpServers: {} },
        mcpToolNames: [],
      },
      writeFileSync: () => {},
      mkdirSync: (d, o) => fs.mkdirSync(d, o),
      chmodSync: () => {},
    });
    const tools = prepared.argv[prepared.argv.indexOf("--tools") + 1];
    assert.match(tools, /(^|,)Skill(,|$)/);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("plugin fixture exposes uniquely named nonce-bearing canary skill", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const pluginDir = fixture.capsule.pluginDirs.find((d) =>
      d.endsWith("capsule.selected-plugin")
    );
    assert.ok(pluginDir);
    const skillMd = path.join(
      pluginDir, "skills", PLUGIN_CANARY_SKILL, "SKILL.md"
    );
    assert.equal(fs.existsSync(skillMd), true);
    const body = fs.readFileSync(skillMd, "utf8");
    assert.match(body, new RegExp(`nonce:${fixture.expected.nonces.plugin}`));
  } finally {
    fixture.cleanup();
  }
});

test("structured proofs grant v1 from init+events even when final JSON is empty/wrong", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const stream = fullStructuredStream(fixture);
    const proofs = parseClaudeStructuredCapabilityProofs(stream, {
      expected: fixture.expected,
      capsule: fixture.capsule,
    });
    assert.ok(proofs);
    assert.deepEqual(proofs.skills, ["capsule.selected-skill"]);
    assert.deepEqual(proofs.plugins, ["capsule.selected-plugin"]);
    assert.deepEqual(proofs.mcp_tools, ["mcp__selected__lookup"]);
    assert.deepEqual(proofs.frameworks, ["capsule.selected-framework"]);
    assert.equal(proofs.content_nonces.skill, fixture.expected.nonces.skill);
    assert.equal(proofs.content_nonces.plugin, fixture.expected.nonces.plugin);
    assert.equal(proofs.content_nonces.framework, fixture.expected.nonces.framework);
    assert.equal(proofs.content_nonces.mcp, fixture.expected.nonces.mcp);
    assert.equal(
      decideContextIsolationCapability({
        expected: fixture.expected,
        observed: proofs,
      }),
      CONTEXT_ISOLATION_CAPABILITY
    );
  } finally {
    fixture.cleanup();
  }
});

test("init-only without Skill/plugin/Read/MCP invocation does not grant", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const stream = [
      initEvent(),
      line({
        type: "assistant",
        session_id: SESSION,
        message: {
          content: [{
            type: "text",
            text: JSON.stringify({
              skills: ["capsule.selected-skill"],
              plugins: ["capsule.selected-plugin"],
              mcp_tools: ["mcp__selected__lookup"],
              frameworks: ["capsule.selected-framework"],
              absent: [...ISOLATION_FORBIDDEN_CANARIES],
              content_nonces: { ...fixture.expected.nonces },
            }),
          }],
        },
      }),
    ].join("\n");
    assert.equal(
      parseClaudeStructuredCapabilityProofs(stream, {
        expected: fixture.expected,
        capsule: fixture.capsule,
      }),
      null
    );
  } finally {
    fixture.cleanup();
  }
});

test("wrong skill id or nonce fails structured proof", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const badSkill = [
      initEvent(),
      assistantUse("tu-skill", "Skill", { skill: "wrong.skill" }),
      userResult("tu-skill", `nonce:${fixture.expected.nonces.skill}\n`),
      assistantUse("tu-plugin", "Skill", { skill: PLUGIN_CANARY_SKILL }),
      userResult("tu-plugin", `nonce:${fixture.expected.nonces.plugin}\n`),
      assistantUse("tu-fw", "Read", { file_path: frameworkPath(fixture) }),
      userResult("tu-fw", JSON.stringify({ content_nonce: fixture.expected.nonces.framework })),
      assistantUse("tu-mcp", "mcp__selected__lookup", {}),
      userResult("tu-mcp", `team-up-canary-ok:${fixture.expected.nonces.mcp}`),
    ].join("\n");
    assert.equal(
      parseClaudeStructuredCapabilityProofs(badSkill, {
        expected: fixture.expected,
        capsule: fixture.capsule,
      }),
      null
    );

    const badNonce = fullStructuredStream(fixture, { skillNonce: "wrong-nonce" });
    assert.equal(
      parseClaudeStructuredCapabilityProofs(badNonce, {
        expected: fixture.expected,
        capsule: fixture.capsule,
      }),
      null
    );
  } finally {
    fixture.cleanup();
  }
});

test("wrong plugin skill/result/nonce or wrong framework Read path fails", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const badPlugin = fullStructuredStream(fixture, {
      pluginNonce: "not-the-plugin-nonce",
    });
    assert.equal(
      parseClaudeStructuredCapabilityProofs(badPlugin, {
        expected: fixture.expected,
        capsule: fixture.capsule,
      }),
      null
    );

    const badPath = fullStructuredStream(fixture, {
      frameworkFilePath: "/tmp/evil/framework.json",
    });
    assert.equal(
      parseClaudeStructuredCapabilityProofs(badPath, {
        expected: fixture.expected,
        capsule: fixture.capsule,
      }),
      null
    );
  } finally {
    fixture.cleanup();
  }
});

test("live observation uses structured proofs not final JSON claims", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    assert.match(
      prepared.argv[prepared.argv.indexOf("--tools") + 1],
      /(^|,)Skill(,|$)/
    );
    const stream = fullStructuredStream(fixture);
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: () => ({ status: 0, stdout: `${stream}\n`, stderr: "" }),
    });
    assert.ok(observed);
    assert.equal(observed.content_nonces.skill, fixture.expected.nonces.skill);
    assert.equal(observed.content_nonces.plugin, fixture.expected.nonces.plugin);
    assert.equal(observed.content_nonces.framework, fixture.expected.nonces.framework);
    assert.equal(observed.content_nonces.mcp, fixture.expected.nonces.mcp);
    assert.equal(
      decideContextIsolationCapability({
        expected: fixture.expected,
        observed,
      }),
      CONTEXT_ISOLATION_CAPABILITY
    );
  } finally {
    fixture.cleanup();
  }
});
