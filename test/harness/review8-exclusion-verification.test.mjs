import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { claudeAdapter } from "../../src/harness/claude.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";
import {
  buildIsolationCanaryFixture,
  collectLiveIsolationObservation,
  decideContextIsolationCapability,
  verifyInitSurfaceExclusion,
  verifyProbeHomeClosedWorld,
  buildAllowedInitSurface,
  CLAUDE_HARNESS_BUILTIN_TOOLS,
  PLUGIN_CANARY_SKILL,
  parseClaudeStructuredCapabilityProofs,
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

test("unselected skill in init denies grant", () => {
  const init = {
    session_id: "s1",
    skills: ["capsule.selected-skill", PLUGIN_CANARY_SKILL, "o9k-scout"],
    plugins: ["capsule.selected-plugin"],
    mcp_servers: ["selected"],
    tools: ["Read", "Skill", "ToolSearch", "mcp__selected__lookup"],
  };
  const result = verifyInitSurfaceExclusion(init, {
    expected: {
      skills: ["capsule.selected-skill"],
      plugins: ["capsule.selected-plugin"],
      mcp_tools: ["mcp__selected__lookup"],
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === "skill" && v.name === "o9k-scout"));
});

test("built-in tool on allowlist still grants", () => {
  for (const tool of CLAUDE_HARNESS_BUILTIN_TOOLS) {
    const init = {
      session_id: "s1",
      skills: ["capsule.selected-skill", PLUGIN_CANARY_SKILL],
      plugins: ["capsule.selected-plugin"],
      mcp_servers: ["selected"],
      tools: [tool, "mcp__selected__lookup"],
    };
    const result = verifyInitSurfaceExclusion(init, {
      expected: {
        skills: ["capsule.selected-skill"],
        plugins: ["capsule.selected-plugin"],
        mcp_tools: ["mcp__selected__lookup"],
      },
    });
    assert.equal(result.ok, true, `built-in tool ${tool} should be allowed`);
  }
});

test("unknown built-in tool denies with named violation", () => {
  const init = {
    session_id: "s1",
    skills: ["capsule.selected-skill", PLUGIN_CANARY_SKILL],
    plugins: ["capsule.selected-plugin"],
    mcp_servers: ["selected"],
    tools: ["Read", "Skill", "ToolSearch", "mcp__selected__lookup", "BrandNewCliTool"],
  };
  const result = verifyInitSurfaceExclusion(init, {
    expected: {
      skills: ["capsule.selected-skill"],
      plugins: ["capsule.selected-plugin"],
      mcp_tools: ["mcp__selected__lookup"],
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [{ kind: "tool", name: "BrandNewCliTool" }]);
});

test("ambient skills materialized into probe HOME deny live observation", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepareClaudeLaunch(fixture);
    const leakRoot = path.join(prepared.env.HOME, ".claude", "skills");
    for (const name of ["o9k-scout", "tim-handoff", "operator-private-runbook"]) {
      fs.mkdirSync(path.join(leakRoot, name), { recursive: true });
      fs.writeFileSync(path.join(leakRoot, name, "SKILL.md"), `# ${name}\n`);
    }
    const homeCheck = verifyProbeHomeClosedWorld(prepared.env.HOME, {
      expectedSkills: fixture.expected.skills,
    });
    assert.equal(homeCheck.ok, false);
    assert.ok(homeCheck.violations.some((v) => v.kind === "skill_dir" && v.name === "o9k-scout"));

    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "claude",
      spawnSyncFn: () => ({ status: 0, stdout: "", stderr: "" }),
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

test("liveProbe without structured stream re-proof does not grant", async () => {
  const { observeContextIsolation } = await import("../../src/harness/isolation-canary.mjs");
  const result = observeContextIsolation({
    adapter: claudeAdapter,
    adapterId: "claude",
    cleanup: true,
    liveProbe: () => ({
      observed: {
        skills: ["capsule.selected-skill"],
        plugins: ["capsule.selected-plugin"],
        mcp_tools: ["mcp__selected__lookup"],
        frameworks: ["capsule.selected-framework"],
        absent: [
          "global.canary-skill",
          "global.canary-plugin",
          "mcp__global__canary",
          "pool.unselected-skill",
          "mcp__excluded__lookup",
          "pool.unselected-framework",
        ],
        content_nonces: {
          skill: "x",
          plugin: "x",
          framework: "x",
          mcp: "x",
        },
      },
      // No stream_text — must fail closed.
    }),
  });
  assert.equal(result.context_isolation, null);
  assert.match(result.error || "", /stream_text|re-proof/i);
});

test("codex live collector path removed — collectLiveIsolationObservation returns null", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = {
      argv: ["codex", "exec"],
      env: { CODEX_HOME: fixture.capsule.codexHome },
    };
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      expected: fixture.expected,
      adapterId: "codex",
      spawnSyncFn: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

test("buildAllowedInitSurface includes selected and plugin canary skill", () => {
  const allowed = buildAllowedInitSurface({
    expected: {
      skills: ["capsule.selected-skill"],
      plugins: ["capsule.selected-plugin"],
      mcp_tools: ["mcp__selected__lookup"],
    },
  });
  assert.ok(allowed.allowedSkills.has("capsule.selected-skill"));
  assert.ok(allowed.allowedSkills.has(PLUGIN_CANARY_SKILL));
  assert.ok(allowed.allowedPlugins.has("capsule.selected-plugin"));
  assert.ok(allowed.allowedTools.has("mcp__selected__lookup"));
});
