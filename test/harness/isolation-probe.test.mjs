import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ISOLATION_CANARIES,
  buildIsolationPrompt,
  evaluateIsolationRun,
  observationFromReport,
  parseIsolationReport,
  plantIsolationFixture,
  PROBE_SELECTED_PLUGIN_SKILL,
  PROBE_SELECTED_SKILL,
} from "../../src/harness/isolation-probe.mjs";

const EXPECTED = {
  skills: [PROBE_SELECTED_SKILL, PROBE_SELECTED_PLUGIN_SKILL],
  plugins: [],
  mcp_tools: [],
  frameworks: [],
};

function reply(report) {
  return `Here you go:\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n`;
}

test("a fenced report is parsed; prose alone is not", () => {
  assert.deepEqual(parseIsolationReport(reply({ skills: ["a"], mcp_tools: [] })), {
    skills: ["a"],
    mcp_tools: [],
  });
  assert.equal(parseIsolationReport("no json at all"), null);
  assert.equal(parseIsolationReport("{ not json }"), null);
});

test("the CLI's own bundled skills are not counted as leaks", () => {
  const observed = observationFromReport({
    report: {
      skills: [PROBE_SELECTED_SKILL, PROBE_SELECTED_PLUGIN_SKILL, "dataviz", "pdf"],
      mcp_tools: [],
    },
    expected: EXPECTED,
  });
  assert.deepEqual(observed.skills, [PROBE_SELECTED_SKILL, PROBE_SELECTED_PLUGIN_SKILL]);
  assert.deepEqual(observed.absent, [...ISOLATION_CANARIES]);
});

test("a leaked canary lands in its own bucket", () => {
  const observed = observationFromReport({
    report: {
      skills: [PROBE_SELECTED_SKILL, "project.canary-skill"],
      mcp_tools: ["mcp__global__canary"],
    },
    expected: EXPECTED,
  });
  assert.equal(observed.skills.includes("project.canary-skill"), true);
  assert.deepEqual(observed.mcp_tools, ["mcp__global__canary"]);
  assert.equal(observed.absent.includes("project.canary-skill"), false);
  assert.equal(observed.absent.includes("mcp__global__canary"), false);
});

test("only selected capabilities visible and every canary absent passes", () => {
  const result = evaluateIsolationRun({
    text: reply({ skills: EXPECTED.skills, mcp_tools: [] }),
    expected: EXPECTED,
  });
  assert.equal(result.context_isolation, "passed");
  assert.deepEqual(result.context_isolation_errors, []);
});

test("a visible canary fails", () => {
  const result = evaluateIsolationRun({
    text: reply({ skills: [...EXPECTED.skills, "global.canary-skill"], mcp_tools: [] }),
    expected: EXPECTED,
  });
  assert.equal(result.context_isolation, "failed");
  assert.equal(
    result.context_isolation_errors.some((e) => /global\.canary-skill/.test(e)),
    true
  );
});

test("absences without the positive controls never pass", () => {
  // Nothing leaked, but the capsule's own skills are missing too: the launch
  // mechanism failed, so the clean canary sheet proves nothing.
  const result = evaluateIsolationRun({
    text: reply({ skills: [], mcp_tools: [] }),
    expected: EXPECTED,
  });
  assert.equal(result.context_isolation, "failed");
});

test("an unreadable report is unverified, never passed", () => {
  const result = evaluateIsolationRun({ text: "I cannot list my tools.", expected: EXPECTED });
  assert.equal(result.context_isolation, "unverified");
});

test("the prompt asks for plugin skills in their namespaced form", () => {
  assert.match(buildIsolationPrompt(), /<plugin>:<skill>/);
});

test("the fixture plants global, project and unselected pool canaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-fixture-"));
  try {
    const fixture = plantIsolationFixture(root);
    for (const rel of [
      ["global-config", "skills", "global.canary-skill", "SKILL.md"],
      ["project", ".claude", "skills", "project.canary-skill", "SKILL.md"],
      ["unselected-pool", "skills", "pool.unselected-skill", "SKILL.md"],
      ["capsule", "context", "skills", PROBE_SELECTED_SKILL, "SKILL.md"],
      ["capsule", "harness", "plugins", "probe-plugin", ".claude-plugin", "plugin.json"],
    ]) {
      assert.equal(fs.existsSync(path.join(root, ...rel)), true, rel.join("/"));
    }
    // The unselected pool skill is planted outside every capsule path.
    assert.equal(fixture.capsule.skillDirs.some((dir) => dir.includes("unselected-pool")), false);
    assert.deepEqual(fixture.expected.skills, EXPECTED.skills);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
