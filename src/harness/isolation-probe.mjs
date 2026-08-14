import fs from "node:fs";
import path from "node:path";

/** Capabilities that must never be visible from inside a run capsule. */
export const ISOLATION_CANARIES = Object.freeze([
  "global.canary-skill",
  "global.canary-plugin",
  "mcp__global__canary",
  "project.canary-skill",
  "pool.unselected-skill",
  "mcp__excluded__lookup",
  "pool.unselected-framework",
]);

/**
 * Compare a harness's self-reported effective capabilities against the
 * capsule's expected set. Verification succeeds only when the observed set
 * matches exactly and every canary is reported absent — a missing report is
 * a failure, never a pass.
 */
export function validateIsolationObservation({ expected = {}, observed = {} } = {}) {
  const errors = [];
  for (const key of ["skills", "plugins", "mcp_tools", "frameworks"]) {
    const want = [...(expected[key] ?? [])].sort();
    const got = [...(observed[key] ?? [])].sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      errors.push(`${key} mismatch: expected ${want.join(",")} got ${got.join(",")}`);
    }
  }
  for (const name of ISOLATION_CANARIES) {
    if (!(observed.absent ?? []).includes(name)) {
      errors.push(`forbidden capability visible: ${name}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Capabilities the probe plants inside the capsule. Each one is a positive
 * control: if a selected capability is not observed, the launch mechanism
 * itself failed and every absence in the same report is worthless.
 */
export const PROBE_SELECTED_SKILL = "capsule-probe-skill";
export const PROBE_SELECTED_PLUGIN_SKILL = "probe-plugin:capsule-probe-plugin";

/**
 * Canaries the probe physically plants. The remaining names in
 * `ISOLATION_CANARIES` are asserted absent but not planted, so their absence
 * is a weaker signal — the record keeps the two apart rather than implying
 * every canary was actually exercised.
 */
export const PLANTED_CANARIES = Object.freeze([
  "global.canary-skill",
  "project.canary-skill",
  "pool.unselected-skill",
]);

function writeSkill(dir, name, description) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nReply with ${name}.\n`
  );
}

/**
 * Plant global, project and unselected-pool capabilities around a capsule that
 * selects exactly one skill and one plugin.
 *
 * Skills resolve only from `$CLAUDE_CONFIG_DIR/skills` and `--plugin-dir`
 * plugins surface as `<plugin>:<skill>`, so a single observed skill list
 * covers both selected and leaked capabilities.
 */
export function plantIsolationFixture(root) {
  const globalConfigDir = path.join(root, "global-config");
  const projectDir = path.join(root, "project");
  const poolDir = path.join(root, "unselected-pool");
  const capsuleRoot = path.join(root, "capsule");
  const skillDir = path.join(capsuleRoot, "context", "skills");
  const pluginDir = path.join(capsuleRoot, "harness", "plugins", "probe-plugin");
  const homeDir = path.join(capsuleRoot, "harness", "home");

  writeSkill(
    path.join(globalConfigDir, "skills", "global.canary-skill"),
    "global.canary-skill",
    "User-global canary that must never reach a run capsule."
  );
  writeSkill(
    path.join(projectDir, ".claude", "skills", "project.canary-skill"),
    "project.canary-skill",
    "Project-local canary that must never reach a run capsule."
  );
  writeSkill(
    path.join(poolDir, "skills", "pool.unselected-skill"),
    "pool.unselected-skill",
    "Installed but unassigned pool canary that must never reach a run capsule."
  );
  // A global MCP server that --strict-mcp-config must drop.
  fs.writeFileSync(
    path.join(globalConfigDir, "settings.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          global: { type: "stdio", command: process.execPath, args: ["-e", ""] },
        },
      },
      null,
      2
    )}\n`
  );

  writeSkill(
    path.join(skillDir, PROBE_SELECTED_SKILL),
    PROBE_SELECTED_SKILL,
    "Selected capsule skill; positive control for capsule skill loading."
  );
  fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "probe-plugin", version: "0.0.1", description: "probe" }, null, 2)}\n`
  );
  writeSkill(
    path.join(pluginDir, "skills", "capsule-probe-plugin"),
    "capsule-probe-plugin",
    "Selected capsule plugin skill; positive control for --plugin-dir loading."
  );

  return {
    globalConfigDir,
    projectDir,
    poolDir,
    capsule: {
      pluginDirs: [pluginDir],
      skillDirs: [skillDir],
      mcpConfig: { mcpServers: {} },
      homeDir,
      authSourceDir: process.env.CLAUDE_CONFIG_DIR || undefined,
    },
    expected: {
      skills: [PROBE_SELECTED_SKILL, PROBE_SELECTED_PLUGIN_SKILL],
      plugins: [],
      mcp_tools: [],
      frameworks: [],
    },
  };
}

export function buildIsolationPrompt() {
  return [
    "Report your own effective capabilities and nothing else.",
    "Output one JSON object, no prose, no markdown fence:",
    '{"skills":["..."],"mcp_tools":["..."]}',
    "skills must list the exact name of every Skill available to you,",
    "including plugin skills in their <plugin>:<skill> form.",
    "mcp_tools must list the exact name of every MCP tool available to you.",
    "List only what is actually available. Never guess a name.",
  ].join(" ");
}

/** Last JSON object in the reply, fences tolerated. `null` when unparseable. */
export function parseIsolationReport(text) {
  const cleaned = String(text || "").replace(/```(?:json)?/g, "");
  let report = null;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== "{") continue;
    for (let j = cleaned.length; j > i; j--) {
      if (cleaned[j - 1] !== "}") continue;
      try {
        const candidate = JSON.parse(cleaned.slice(i, j));
        if (Array.isArray(candidate?.skills) || Array.isArray(candidate?.mcp_tools)) {
          report = candidate;
        }
      } catch {
        continue;
      }
      break;
    }
  }
  if (!report) return null;
  return {
    skills: (report.skills ?? []).map(String),
    mcp_tools: (report.mcp_tools ?? []).map(String),
  };
}

/**
 * Reduce a raw report to the probe's namespace.
 *
 * The CLI ships its own bundled skills; those are harness-intrinsic, not
 * capabilities team-up assigned, so only planted and selected names are
 * compared. A canary that shows up anywhere in the raw report is reported
 * present, never quietly filtered away.
 */
export function observationFromReport({ report, expected, canaries = ISOLATION_CANARIES }) {
  const reported = new Set([...(report.skills ?? []), ...(report.mcp_tools ?? [])]);
  const relevant = (names) => names.filter((name) => reported.has(name));
  const isMcp = (name) => name.startsWith("mcp__");
  return {
    skills: relevant([...(expected.skills ?? []), ...canaries.filter((n) => !isMcp(n))]),
    plugins: [],
    mcp_tools: relevant([...(expected.mcp_tools ?? []), ...canaries.filter(isMcp)]),
    frameworks: [],
    absent: canaries.filter((name) => !reported.has(name)),
  };
}

/**
 * Turn one launch into a `context_isolation` check value.
 *
 * An unparseable or missing report is `unverified` — never `passed`. A report
 * that proves a leak, or that fails to show a selected capability, is
 * `failed`: without its positive controls the run proves nothing.
 */
export function evaluateIsolationRun({ text, expected }) {
  const report = parseIsolationReport(text);
  if (!report) {
    return { context_isolation: "unverified", context_isolation_errors: ["unparseable capability report"] };
  }
  const observed = observationFromReport({ report, expected });
  const result = validateIsolationObservation({ expected, observed });
  return {
    context_isolation: result.ok ? "passed" : "failed",
    context_isolation_errors: result.errors,
    context_isolation_planted: [...PLANTED_CANARIES],
    context_isolation_observed: observed,
  };
}
