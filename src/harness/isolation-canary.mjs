import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync as realSpawnSync } from "node:child_process";
import { materializeCapabilityCapsule, buildStrictMcpConfig } from "../capabilities/capsule.mjs";
import { randomContentNonce } from "../capabilities/mcp-schema.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "./capabilities.mjs";

const CANARY_MCP_SERVER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "canary-mcp-server.mjs"
);
const CANARY_TOOL_RESULT = "team-up-canary-ok";
const FORMAT_PROBE_CLAUDE = "format-probe-claude";
const FORMAT_PROBE_MCP = "format-probe-mcp";

export const ISOLATION_FORBIDDEN_CANARIES = Object.freeze([
  "global.canary-skill",
  "global.canary-plugin",
  "mcp__global__canary",
  "pool.unselected-skill",
  "mcp__excluded__lookup",
  "pool.unselected-framework",
]);

/** Uniquely named skill shipped inside the selected plugin fixture for nonce proof. */
export const PLUGIN_CANARY_SKILL = "capsule.selected-plugin-canary";

function contentNonceField(text, nonce) {
  return `${text}\nnonce:${nonce}\n`;
}

export function validateIsolationObservation({ expected, observed }) {
  const errors = [];
  for (const key of ["skills", "plugins", "mcp_tools", "frameworks"]) {
    const want = [...(expected[key] ?? [])].sort();
    const got = [...(observed[key] ?? [])].sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      errors.push(`${key} mismatch: expected ${want.join(",")} got ${got.join(",")}`);
    }
  }
  for (const name of ISOLATION_FORBIDDEN_CANARIES) {
    if (!(observed.absent ?? []).includes(name)) {
      errors.push(`forbidden capability visible: ${name}`);
    }
  }
  if (expected.nonces) {
    const want = expected.nonces;
    const got = observed.content_nonces;
    if (!got || typeof got !== "object" || Array.isArray(got)) {
      errors.push("content_nonces missing or malformed");
    } else {
      for (const key of ["skill", "plugin", "framework", "mcp"]) {
        if (want[key] != null && got[key] !== want[key]) {
          errors.push(`content_nonces.${key} mismatch: expected ${want[key]} got ${got[key] ?? "missing"}`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function writePackage(root, {
  id,
  version = "1.0.0",
  skills = [],
  plugins = [],
  frameworks = [],
  mcps = [],
  nonces = {},
}) {
  const pkg = path.join(root, id);
  fs.mkdirSync(pkg, { recursive: true });
  const provides = { skills: [], plugins: [], frameworks: [], mcps: [] };
  for (const name of skills) {
    const rel = `skills/${name}/SKILL.md`;
    const nonce = nonces.skill || randomContentNonce();
    writeFile(
      path.join(pkg, rel),
      `---\nname: ${name}\ndescription: canary skill ${name}\n---\n${contentNonceField(`# ${name}\ncanary skill`, nonce)}`
    );
    provides.skills.push(rel);
  }
  for (const name of plugins) {
    const rel = `plugins/${name}`;
    const nonce = nonces.plugin || randomContentNonce();
    const pluginDoc = {
      name,
      version: "1.0.0",
      description: `canary plugin ${name}`,
      content_nonce: nonce,
    };
    writeFile(path.join(pkg, rel, "plugin.json"), JSON.stringify(pluginDoc, null, 2) + "\n");
    writeFile(
      path.join(pkg, rel, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name, version: "1.0.0", content_nonce: nonce }, null, 2) + "\n"
    );
    // Invokable Skill surface carrying the plugin nonce (not metadata-only).
    const pluginSkillRel = `${rel}/skills/${PLUGIN_CANARY_SKILL}/SKILL.md`;
    writeFile(
      path.join(pkg, pluginSkillRel),
      `---\nname: ${PLUGIN_CANARY_SKILL}\ndescription: canary skill for plugin ${name}\n---\n${contentNonceField(`# ${PLUGIN_CANARY_SKILL}\nplugin canary skill`, nonce)}`
    );
    provides.plugins.push(rel);
  }
  for (const name of frameworks) {
    const rel = `frameworks/${name}/framework.json`;
    const nonce = nonces.framework || randomContentNonce();
    writeFile(path.join(pkg, rel), JSON.stringify({
      name,
      version: "1.0.0",
      description: `canary framework ${name}`,
      content_nonce: nonce,
    }, null, 2) + "\n");
    provides.frameworks.push(rel);
  }
  for (const mcp of mcps) {
    const rel = `mcps/${mcp.server}/mcp.json`;
    const toolName = mcp.tools[0] || "lookup";
    const nonce = nonces.mcp || randomContentNonce();
    writeFile(path.join(pkg, rel), JSON.stringify({
      tools: mcp.tools,
      mcpServers: {
        [mcp.server]: {
          type: "stdio",
          command: process.execPath,
          args: [CANARY_MCP_SERVER],
          env: {
            TEAM_UP_CANARY_TOOL: toolName,
            TEAM_UP_CANARY_RESULT: CANARY_TOOL_RESULT,
            TEAM_UP_CANARY_NONCE: nonce,
          },
          tools: mcp.tools,
        },
      },
    }, null, 2) + "\n");
    provides.mcps.push(rel);
  }
  writeFile(path.join(pkg, "capability.json"), JSON.stringify({
    schema_version: 1,
    id,
    version,
    display_name: id,
    provides,
    permissions: { network: false, commands: [], filesystem: "none" },
  }, null, 2) + "\n");
  return {
    package: id,
    id,
    version,
    checksum: `sha256:fixture-${id}`,
    packageDir: pkg,
    reason: "selected",
    estimated_description_tokens: 1,
    mcp_tool_count: mcps.reduce((n, m) => n + m.tools.length, 0),
  };
}

function listChildDirs(dirs = []) {
  const names = [];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) names.push(entry.name);
    }
  }
  return [...new Set(names)].sort();
}

function flagValues(argv, flag) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) {
      values.push(argv[i + 1]);
      i++;
    }
  }
  return values;
}

function collectCapsuleMcpTools(effective, runRoot) {
  const mcpToolsByServer = {};
  const mcpToolNames = [];
  for (const item of effective.packages ?? []) {
    for (const rel of item.resolved?.mcps ?? []) {
      const document = JSON.parse(fs.readFileSync(path.join(runRoot, rel), "utf8"));
      const sharedTools = Array.isArray(document.tools) ? document.tools : [];
      for (const [name, server] of Object.entries(document.mcpServers ?? {})) {
        const tools = Array.isArray(server?.tools) ? server.tools : sharedTools;
        mcpToolsByServer[name] = tools;
        for (const tool of tools) {
          mcpToolNames.push(
            `mcp__${name}__${String(tool).replace(/-/g, "_")}`
          );
        }
      }
    }
  }
  return { mcpToolNames, mcpToolsByServer };
}

/**
 * Build global + pool canaries and a capsule containing only the selected set.
 */
export function buildIsolationCanaryFixture(root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-canary-"))) {
  const globalHome = path.join(root, "global-home");
  const ambientProject = path.join(root, "ambient-project");
  const pool = path.join(root, "pool");
  const runRoot = path.join(root, "run");
  fs.mkdirSync(runRoot, { recursive: true });
  fs.mkdirSync(ambientProject, { recursive: true });

  const nonces = {
    skill: randomContentNonce(),
    plugin: randomContentNonce(),
    framework: randomContentNonce(),
    mcp: randomContentNonce(),
  };

  writeFile(
    path.join(globalHome, ".claude", "skills", "global.canary-skill", "SKILL.md"),
    "# global.canary-skill\n"
  );
  const globalPluginCache = path.join(
    globalHome, ".claude", "plugins", "cache", "canary", "global.canary-plugin", "1.0.0"
  );
  writeFile(
    path.join(globalPluginCache, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "global.canary-plugin", version: "1.0.0" }, null, 2) + "\n"
  );
  writeFile(
    path.join(globalPluginCache, "plugin.json"),
    JSON.stringify({ name: "global.canary-plugin", version: "1.0.0" }, null, 2) + "\n"
  );
  writeFile(
    path.join(globalHome, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "global.canary-plugin@canary": [{
          scope: "user",
          installPath: globalPluginCache,
          version: "1.0.0",
          installedAt: "2026-07-26T00:00:00.000Z",
          lastUpdated: "2026-07-26T00:00:00.000Z",
        }],
      },
    }, null, 2) + "\n"
  );
  writeFile(
    path.join(globalHome, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        global: {
          type: "stdio",
          command: process.execPath,
          args: [CANARY_MCP_SERVER],
          env: {
            TEAM_UP_CANARY_TOOL: "canary",
            TEAM_UP_CANARY_RESULT: CANARY_TOOL_RESULT,
          },
        },
      },
    }, null, 2) + "\n"
  );
  writeFile(
    path.join(globalHome, ".codex", "skills", "global.canary-skill", "SKILL.md"),
    "# global.canary-skill\n"
  );

  const selectedSkill = writePackage(pool, {
    id: "fixture.selected-skill",
    skills: ["capsule.selected-skill"],
    nonces: { skill: nonces.skill },
  });
  const selectedPlugin = writePackage(pool, {
    id: "fixture.selected-plugin",
    plugins: ["capsule.selected-plugin"],
    nonces: { plugin: nonces.plugin },
  });
  const selectedMcp = writePackage(pool, {
    id: "fixture.selected-mcp",
    mcps: [{ server: "selected", tools: ["lookup"] }],
    nonces: { mcp: nonces.mcp },
  });
  const selectedFramework = writePackage(pool, {
    id: "fixture.selected-framework",
    frameworks: ["capsule.selected-framework"],
    nonces: { framework: nonces.framework },
  });
  writePackage(pool, {
    id: "fixture.unselected-skill",
    skills: ["pool.unselected-skill"],
  });
  writePackage(pool, {
    id: "fixture.unselected-framework",
    frameworks: ["pool.unselected-framework"],
  });
  writePackage(pool, {
    id: "fixture.excluded-mcp",
    mcps: [{ server: "excluded", tools: ["lookup"] }],
  });

  const packages = [selectedSkill, selectedPlugin, selectedMcp, selectedFramework];
  const effective = materializeCapabilityCapsule({
    runRoot,
    specialistId: "fixture.isolation",
    packages,
    exclusions: ["fixture.excluded-mcp"],
  });
  const mcpBits = collectCapsuleMcpTools(effective, runRoot);
  const capsule = {
    pluginDirs: effective.packages.flatMap((item) =>
      item.resolved.plugins.map((rel) => path.join(runRoot, rel))),
    mcpConfig: buildStrictMcpConfig(effective, runRoot),
    skillDirs: [path.join(runRoot, "context", "skills")],
    frameworkDirs: [path.join(runRoot, "context", "framework")],
    codexHome: path.join(runRoot, "harness", "home"),
    effective,
    nonces,
    ...mcpBits,
  };

  const expected = {
    skills: ["capsule.selected-skill"],
    plugins: ["capsule.selected-plugin"],
    mcp_tools: ["mcp__selected__lookup"],
    frameworks: ["capsule.selected-framework"],
    nonces: { ...nonces },
  };
  const codexExpected = null;

  return {
    root,
    globalHome,
    ambientProject,
    runRoot,
    capsule,
    expected,
    codexExpected,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function parseIsolationObservationJson(text) {
  if (text == null) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      obj = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  for (const key of ["skills", "plugins", "mcp_tools", "frameworks", "absent"]) {
    if (!Array.isArray(obj[key])) return null;
  }
  const content_nonces = obj.content_nonces;
  if (content_nonces != null
    && (typeof content_nonces !== "object" || Array.isArray(content_nonces))) {
    return null;
  }
  return {
    skills: obj.skills.map(String),
    plugins: obj.plugins.map(String),
    mcp_tools: obj.mcp_tools.map(String),
    frameworks: obj.frameworks.map(String),
    absent: obj.absent.map(String),
    ...(content_nonces ? { content_nonces: Object.fromEntries(
      Object.entries(content_nonces).map(([k, v]) => [k, String(v)])
    ) } : {}),
  };
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object") return block.text || "";
      return "";
    }).join("");
  }
  return "";
}

/**
 * Exact Claude 2.1.220 stream-json tool proof:
 * - Bind session from system/init
 * - Require tool_use only on an assistant event
 * - Require a strictly later user event with matching tool_result + tool_use_id
 * - Require exact canary payload containing the fresh nonce (not substring-only)
 * - Reject same-event use+result, wrong roles, duplicate uses/results, wrong order
 */
export function parseClaudeStreamToolProof(streamText, { toolName, nonce } = {}) {
  if (!streamText || !toolName || !nonce) return null;
  const expectedPayload = `team-up-canary-ok:${nonce}`;
  let sessionId = null;
  let toolUseId = null;
  let toolUseEventIndex = -1;
  let sawToolResult = false;
  let eventIndex = -1;

  for (const line of String(streamText).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!evt || typeof evt !== "object" || Array.isArray(evt)) continue;
    eventIndex += 1;

    if (evt.type === "system" && evt.subtype === "init") {
      if (typeof evt.session_id !== "string" || !evt.session_id) return null;
      if (sessionId && sessionId !== evt.session_id) return null;
      sessionId = evt.session_id;
      continue;
    }

    if (!sessionId) continue;
    // Tool events must carry the bound session_id (missing is invalid).
    if (evt.session_id !== sessionId) return null;

    const content = evt.message?.content;
    if (!Array.isArray(content)) continue;

    let sawUseInThisEvent = false;
    let sawResultInThisEvent = false;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use" && block.name === toolName) {
        if (evt.type !== "assistant") return null;
        if (typeof block.id !== "string" || !block.id) return null;
        if (toolUseId) return null; // duplicate selected tool_use
        if (sawToolResult) return null;
        toolUseId = block.id;
        toolUseEventIndex = eventIndex;
        sawUseInThisEvent = true;
      }
      if (block.type === "tool_result") {
        if (!toolUseId) {
          // Result before our tool_use — only reject if it claims our id later.
          // Unrelated results before use are ignored until use exists.
          continue;
        }
        if (block.tool_use_id !== toolUseId) continue;
        if (evt.type !== "user") return null;
        if (eventIndex <= toolUseEventIndex) return null; // same or earlier event
        if (sawToolResult) return null; // duplicate matching result
        const text = toolResultText(block.content);
        if (text === expectedPayload || text.trim() === expectedPayload) {
          sawToolResult = true;
          sawResultInThisEvent = true;
        } else {
          return null;
        }
      }
    }
    if (sawUseInThisEvent && sawResultInThisEvent) return null;
  }

  if (!sessionId || !toolUseId || !sawToolResult) return null;
  return {
    tool: toolName,
    nonce,
    tool_use_id: toolUseId,
    session_id: sessionId,
  };
}

function resultContainsExactNonce(text, nonce) {
  if (text == null || nonce == null) return false;
  const raw = String(text);
  const trimmed = raw.trim();
  if (trimmed === `team-up-canary-ok:${nonce}`) return true;
  const escaped = String(nonce).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`nonce:${escaped}(?![A-Za-z0-9_-])`).test(raw)) return true;
  if (new RegExp(`"content_nonce"\\s*:\\s*"${escaped}"`).test(raw)) return true;
  return false;
}

function collectOrderedToolPairs(streamText, sessionId) {
  const pairs = [];
  const syntheticTexts = [];
  let pending = null; // { id, name, input, eventIndex }
  let eventIndex = -1;
  for (const line of String(streamText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!evt || typeof evt !== "object" || Array.isArray(evt)) continue;
    eventIndex += 1;
    if (evt.type === "system" && evt.subtype === "init") continue;
    if (evt.session_id !== sessionId) continue;
    const content = evt.message?.content;
    if (!Array.isArray(content)) continue;

    // Claude 2.1.220 injects skill bodies as synthetic user text after Skill launch.
    if (evt.type === "user") {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          syntheticTexts.push({
            text: block.text,
            eventIndex,
            isSynthetic: evt.isSynthetic === true,
          });
        }
      }
    }

    if (evt.type === "assistant") {
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        if (typeof block.id !== "string" || !block.id) continue;
        if (typeof block.name !== "string" || !block.name) continue;
        pending = {
          id: block.id,
          name: block.name,
          input: block.input && typeof block.input === "object" ? block.input : {},
          eventIndex,
        };
      }
      continue;
    }

    if (evt.type === "user" && pending) {
      for (const block of content) {
        if (block?.type !== "tool_result") continue;
        if (block.tool_use_id !== pending.id) continue;
        if (eventIndex <= pending.eventIndex) continue;
        pairs.push({
          ...pending,
          resultText: toolResultText(block.content),
          resultEventIndex: eventIndex,
        });
        pending = null;
        break;
      }
    }
  }
  return { pairs, syntheticTexts };
}

function skillNameMatches(inputSkill, want) {
  const got = String(inputSkill || "");
  if (!got || !want) return false;
  if (got === want) return true;
  // Plugin skills appear as plugin:skill with dots→hyphens in the skill segment.
  if (got.endsWith(`:${want}`)) return true;
  const hyphenated = want.replace(/\./g, "-");
  if (got === hyphenated || got.endsWith(`:${hyphenated}`)) return true;
  if (got.endsWith(`:${PLUGIN_CANARY_SKILL}`) || got === PLUGIN_CANARY_SKILL) {
    return want === PLUGIN_CANARY_SKILL;
  }
  return false;
}

function findSkillLaunchProof(pairs, syntheticTexts, skillName, nonce) {
  const launch = pairs.find((p) =>
    p.name === "Skill"
    && skillNameMatches(p.input.skill, skillName)
    && /Launching skill:/i.test(p.resultText)
  );
  if (!launch) {
    // Also accept tool_result that itself embeds the nonce (fixtures / future CLIs).
    const direct = pairs.find((p) =>
      p.name === "Skill"
      && skillNameMatches(p.input.skill, skillName)
      && resultContainsExactNonce(p.resultText, nonce)
    );
    return direct || null;
  }
  const body = syntheticTexts.find((s) =>
    s.eventIndex >= launch.eventIndex
    && resultContainsExactNonce(s.text, nonce)
    && (
      s.text.includes(skillName)
      || s.text.includes(skillName.replace(/\./g, "-"))
      || /Base directory for this skill:/i.test(s.text)
    )
  );
  if (!body) return null;
  return { ...launch, skillBodyText: body.text };
}

/**
 * Derive selected capability + content_nonce proof from Claude 2.1.220
 * structured init + correlated Skill / plugin Skill / Read / MCP events.
 * Final model JSON is never authoritative for selected/nonce proof.
 */
export function parseClaudeStructuredCapabilityProofs(streamText, {
  expected = null,
  capsule = null,
} = {}) {
  if (!expected?.nonces || !capsule) return null;
  const init = extractStructuredInitInventory(streamText);
  if (!init) return null;

  for (const bad of ["global.canary-skill", "global.canary-plugin"]) {
    if ((init.skills || []).includes(bad) || (init.plugins || []).includes(bad)) {
      return null;
    }
  }
  if ((init.mcp_servers || []).includes("global")
    || (init.mcp_servers || []).includes("excluded")) {
    return null;
  }
  if ((init.tools || []).includes("mcp__global__canary")
    || (init.tools || []).includes("mcp__excluded__lookup")) {
    return null;
  }

  const wantSkill = (expected.skills || [])[0];
  const wantPlugin = (expected.plugins || [])[0];
  const wantFramework = (expected.frameworks || [])[0];
  const wantMcp = (expected.mcp_tools || [])[0];
  if (!wantSkill || !wantPlugin || !wantFramework || !wantMcp) return null;
  if (!(init.skills || []).includes(wantSkill)) return null;
  if (!(init.plugins || []).includes(wantPlugin)) return null;

  const { pairs, syntheticTexts } = collectOrderedToolPairs(streamText, init.session_id);
  if (!pairs.length) return null;

  const skillPair = findSkillLaunchProof(
    pairs, syntheticTexts, wantSkill, expected.nonces.skill
  );
  if (!skillPair) return null;

  const pluginPair = findSkillLaunchProof(
    pairs, syntheticTexts, PLUGIN_CANARY_SKILL, expected.nonces.plugin
  );
  if (!pluginPair) return null;

  const frameworkRoots = (capsule.frameworkDirs || []).map((d) => path.resolve(d));
  const expectedFwPaths = new Set(
    frameworkRoots.map((root) =>
      path.resolve(root, wantFramework, "framework.json")
    )
  );
  const frameworkPair = pairs.find((p) => {
    if (p.name !== "Read") return false;
    const filePath = path.resolve(
      String(p.input.file_path || p.input.path || "")
    );
    if (!expectedFwPaths.has(filePath)) return false;
    return resultContainsExactNonce(p.resultText, expected.nonces.framework);
  });
  if (!frameworkPair) return null;

  const mcpPair = pairs.find((p) =>
    p.name === wantMcp
    && resultContainsExactNonce(p.resultText, expected.nonces.mcp)
  );
  if (!mcpPair) return null;

  // Prove no forbidden skill/plugin/MCP/framework result was produced.
  for (const pair of pairs) {
    const skillName = String(pair.input.skill || "");
    if (skillName === "global.canary-skill" || skillName === "pool.unselected-skill") {
      return null;
    }
    if (pair.name === "mcp__global__canary" || pair.name === "mcp__excluded__lookup") {
      return null;
    }
    const readPath = String(pair.input.file_path || pair.input.path || "");
    if (/pool\.unselected-framework|global\.canary/i.test(readPath)) return null;
  }

  const mcpTools = (init.tools || []).filter((t) => String(t).startsWith("mcp__"));
  if (!mcpTools.includes(wantMcp)) mcpTools.push(wantMcp);

  const visible = new Set([
    wantSkill,
    wantPlugin,
    wantMcp,
    wantFramework,
    PLUGIN_CANARY_SKILL,
    ...(init.skills || []),
    ...(init.plugins || []),
    ...mcpTools,
  ]);
  const absent = ISOLATION_FORBIDDEN_CANARIES.filter((name) => {
    if (visible.has(name)) return false;
    if ((init.skills || []).includes(name)) return false;
    if ((init.plugins || []).includes(name)) return false;
    if ((init.tools || []).includes(name)) return false;
    if (name.startsWith("mcp__")
      && (init.mcp_servers || []).some((s) => name.includes(`__${s}__`))) {
      return false;
    }
    return true;
  });
  if (!absentListComplete(absent)) return null;

  return {
    skills: [wantSkill],
    plugins: [wantPlugin],
    mcp_tools: [wantMcp],
    frameworks: [wantFramework],
    absent,
    content_nonces: {
      skill: expected.nonces.skill,
      plugin: expected.nonces.plugin,
      framework: expected.nonces.framework,
      mcp: expected.nonces.mcp,
    },
    _init: init,
    _structured_proofs: {
      skill_tool_use_id: skillPair.id,
      plugin_tool_use_id: pluginPair.id,
      framework_tool_use_id: frameworkPair.id,
      mcp_tool_use_id: mcpPair.id,
    },
  };
}

/**
 * Derive structured inventory from Claude stream-json system/init only.
 * Model-authored text JSON is never sufficient alone.
 */
export function extractStructuredInitInventory(streamText) {
  for (const line of String(streamText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (evt?.type !== "system" || evt.subtype !== "init") continue;
    if (typeof evt.session_id !== "string" || !evt.session_id) return null;
    const tools = Array.isArray(evt.tools) ? evt.tools.map(String) : [];
    const skills = Array.isArray(evt.skills)
      ? evt.skills.map((s) => (typeof s === "string" ? s : String(s?.name || ""))).filter(Boolean)
      : [];
    const plugins = Array.isArray(evt.plugins)
      ? evt.plugins.map((p) => (typeof p === "string" ? p : String(p?.name || ""))).filter(Boolean)
      : [];
    const mcp_servers = Array.isArray(evt.mcp_servers)
      ? evt.mcp_servers
        .map((s) => (typeof s === "string" ? s : String(s?.name || "")))
        .filter(Boolean)
      : [];
    return {
      session_id: evt.session_id,
      tools,
      skills,
      plugins,
      mcp_servers,
      claude_code_version: evt.claude_code_version || null,
    };
  }
  return null;
}

function extractInventoryFromStream(streamText) {
  // Assistant text may carry content_nonces after structured init + tool proof.
  for (const line of String(streamText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const content = evt.message?.content || evt.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "text") continue;
      const inv = parseIsolationObservationJson(block.text);
      if (inv) return inv;
    }
  }
  return null;
}

function probeMcpServerDoc(serverName, resultText) {
  return {
    type: "stdio",
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(resultText)})`],
    env: { TEAM_UP_PROBE: serverName },
  };
}

/**
 * Detect whether Claude reads user-global MCP from ~/.claude.json.
 * Probes isolated temp HOMEs; returns null on uncertainty (fail closed).
 */
export function detectClaudeUserMcpConfigFormat({ spawnSyncFn = realSpawnSync } = {}) {
  const neutralDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-claude-mcp-format-"));
  const claudeJsonHome = fs.mkdtempSync(path.join(os.tmpdir(), "tu-claude-json-home-"));
  const mcpJsonHome = fs.mkdtempSync(path.join(os.tmpdir(), "tu-mcp-json-home-"));
  try {
    writeFile(
      path.join(claudeJsonHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          [FORMAT_PROBE_CLAUDE]: probeMcpServerDoc(FORMAT_PROBE_CLAUDE, `${FORMAT_PROBE_CLAUDE}: ok\n`),
        },
      }, null, 2) + "\n"
    );
    writeFile(
      path.join(mcpJsonHome, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          [FORMAT_PROBE_MCP]: probeMcpServerDoc(FORMAT_PROBE_MCP, `${FORMAT_PROBE_MCP}: ok\n`),
        },
      }, null, 2) + "\n"
    );

    const claudeRun = spawnSyncFn("claude", ["mcp", "list"], {
      encoding: "utf8",
      timeout: 30_000,
      cwd: neutralDir,
      env: { ...process.env, HOME: claudeJsonHome },
    });
    const mcpRun = spawnSyncFn("claude", ["mcp", "list"], {
      encoding: "utf8",
      timeout: 30_000,
      cwd: neutralDir,
      env: { ...process.env, HOME: mcpJsonHome },
    });
    if (claudeRun.error || mcpRun.error
      || claudeRun.status !== 0 || mcpRun.status !== 0) {
      return null;
    }
    const fromClaudeJson = parseClaudeMcpList(
      `${claudeRun.stdout || ""}\n${claudeRun.stderr || ""}`
    ).includes(FORMAT_PROBE_CLAUDE);
    const fromMcpJson = parseClaudeMcpList(
      `${mcpRun.stdout || ""}\n${mcpRun.stderr || ""}`
    ).includes(FORMAT_PROBE_MCP);
    if (fromClaudeJson && !fromMcpJson) return "claude.json";
    if (fromMcpJson && !fromClaudeJson) return "mcp.json";
    return null;
  } finally {
    for (const dir of [neutralDir, claudeJsonHome, mcpJsonHome]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

/**
 * Launch-surface precondition only. Live token grant requires
 * collectLiveIsolationObservation (or an injected liveProbe.observed).
 */
export function collectLaunchIsolationObservation({
  prepared,
  capsule,
  adapterId = "claude",
} = {}) {
  if (!prepared?.argv || !capsule) return null;
  try {
    if (adapterId === "claude") {
      // Capsule isolation uses auth-only HOME (not --bare; --bare breaks login).
      if (!prepared.env?.HOME) return null;
      if (prepared.argv.includes("--bare")) return null;
    }
    if (adapterId === "codex") {
      if (!prepared.env?.CODEX_HOME) return null;
      if (prepared.env.CODEX_HOME !== capsule.codexHome) return null;
    }

    const skills = adapterId === "codex"
      ? listChildDirs([path.join(capsule.codexHome, "skills")])
      : listChildDirs(capsule.skillDirs);
    const frameworks = adapterId === "codex"
      ? []
      : listChildDirs(capsule.frameworkDirs);
    const plugins = adapterId === "codex"
      ? []
      : [...new Set((capsule.pluginDirs ?? []).map((dir) => path.basename(dir)))].sort();

    let mcp_tools = [...(capsule.mcpToolNames ?? [])].sort();
    if (adapterId === "claude") {
      const toolsCsv = flagValues(prepared.argv, "--tools")[0]
        || flagValues(prepared.argv, "--allowedTools")[0]
        || "";
      const fromArgv = toolsCsv
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.startsWith("mcp__") && !t.includes("team_up_command_broker"))
        .sort();
      if (fromArgv.length) mcp_tools = fromArgv;
      const mcpPath = flagValues(prepared.argv, "--mcp-config")[0];
      if (!mcpPath || !fs.existsSync(mcpPath)) return null;
      const mcpDoc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      const servers = Object.keys(mcpDoc.mcpServers || {});
      if (servers.includes("global") || servers.includes("excluded")) {
        for (const name of servers) {
          if (name === "global") mcp_tools.push("mcp__global__canary");
          if (name === "excluded") mcp_tools.push("mcp__excluded__lookup");
        }
        mcp_tools = [...new Set(mcp_tools)].sort();
      }
      if (!prepared.argv.includes("--strict-mcp-config")) return null;
    } else {
      const configPath = path.join(capsule.codexHome, "config.toml");
      if (!fs.existsSync(configPath)) return null;
      const toml = fs.readFileSync(configPath, "utf8");
      if (/\[mcp_servers\.global\]/.test(toml) || /\[mcp_servers\.excluded\]/.test(toml)) {
        if (/\[mcp_servers\.global\]/.test(toml)) mcp_tools.push("mcp__global__canary");
        if (/\[mcp_servers\.excluded\]/.test(toml)) mcp_tools.push("mcp__excluded__lookup");
        mcp_tools = [...new Set(mcp_tools)].sort();
      }
      if (fs.existsSync(path.join(capsule.codexHome, "skills", "global.canary-skill"))) {
        skills.push("global.canary-skill");
      }
    }

    if (!Array.isArray(skills) || !Array.isArray(plugins)
      || !Array.isArray(mcp_tools) || !Array.isArray(frameworks)) {
      return null;
    }
    if (!mcp_tools.includes("mcp__selected__lookup")) return null;

    const present = new Set([...skills, ...plugins, ...mcp_tools, ...frameworks]);
    const absent = ISOLATION_FORBIDDEN_CANARIES.filter((name) => !present.has(name));
    return {
      skills: [...skills].sort(),
      plugins: [...plugins].sort(),
      mcp_tools: [...mcp_tools].sort(),
      frameworks: [...frameworks].sort(),
      absent,
    };
  } catch {
    return null;
  }
}

function parseClaudePluginList(text, { sessionOnly = false } = {}) {
  const names = [];
  let inSession = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/Session-only plugins/i.test(line)) {
      inSession = true;
      continue;
    }
    if (/^Installed plugins:/i.test(line)) {
      inSession = false;
      continue;
    }
    if (sessionOnly && !inSession) continue;
    const m = line.match(/❯\s+([^\s@]+)@/);
    if (m) names.push(m[1]);
  }
  return [...new Set(names)].sort();
}

function globalsPlanted(globalHome, adapterId) {
  if (adapterId === "codex") {
    return fs.existsSync(path.join(
      globalHome, ".codex", "skills", "global.canary-skill", "SKILL.md"
    ));
  }
  const claudeJsonPath = path.join(globalHome, ".claude.json");
  if (!fs.existsSync(claudeJsonPath)) return false;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
  } catch {
    return false;
  }
  if (!doc?.mcpServers?.global) return false;
  return (
    fs.existsSync(path.join(globalHome, ".claude", "skills", "global.canary-skill", "SKILL.md"))
    && fs.existsSync(path.join(globalHome, ".claude", "plugins", "installed_plugins.json"))
  );
}

function readClaudeJsonMcpServers(globalHome) {
  const claudeJsonPath = path.join(globalHome, ".claude.json");
  if (!fs.existsSync(claudeJsonPath)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    return doc?.mcpServers ?? null;
  } catch {
    return null;
  }
}

/**
 * Speak MCP JSON-RPC to a configured stdio server and execute its canary tool.
 * Diagnostics/fixtures only — MUST NOT satisfy live model proof.
 */
export function executeConfiguredMcpCanaryTool(server, {
  spawnSyncFn = realSpawnSync,
  toolName = "lookup",
  expectedText = CANARY_TOOL_RESULT,
} = {}) {
  if (!server?.command) return null;
  const args = Array.isArray(server.args) ? server.args : [];
  const env = { ...process.env, ...(server.env || {}) };
  const script = `
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(server.command)}, ${JSON.stringify(args)}, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: ${JSON.stringify(env)},
});
let buf = '';
const pending = new Map();
let nextId = 1;
function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error('timeout ' + method)), 8000);
  });
}
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});
(async () => {
  try {
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'team-up-canary', version: '1.0.0' },
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/initialized',
    }) + '\\n');
    const listed = await send('tools/list', {});
    const names = (listed.tools || []).map((t) => t.name);
    if (!names.includes(${JSON.stringify(toolName)})) {
      throw new Error('tool missing: ' + names.join(','));
    }
    const called = await send('tools/call', { name: ${JSON.stringify(toolName)}, arguments: {} });
    const text = (called.content || []).map((c) => c.text || '').join('');
    if (!text.includes(${JSON.stringify(expectedText)})) {
      throw new Error('bad tool result: ' + text);
    }
    process.stdout.write('OK\\n');
    child.kill('SIGTERM');
    process.exit(0);
  } catch (e) {
    process.stderr.write(String(e && e.message || e));
    child.kill('SIGTERM');
    process.exit(1);
  }
})();
`;
  const run = spawnSyncFn(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 15_000,
    env,
  });
  if (run.error || run.status !== 0) return null;
  if (!String(run.stdout || "").includes("OK")) return null;
  return { tool: toolName, result: expectedText };
}

function parseClaudeMcpList(text) {
  const names = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.:-]+)\s*:/);
    if (m) names.push(m[1]);
  }
  return [...new Set(names)].sort();
}

const INVENTORY_PROMPT = [
  "You are an isolation canary.",
  "Call these tools in order, then stop:",
  "1) Skill tool with skill=capsule.selected-skill exactly once.",
  `2) Skill tool with skill=${PLUGIN_CANARY_SKILL} exactly once.`,
  "3) Read the selected framework JSON at the --add-dir framework path ending in capsule.selected-framework/framework.json exactly once.",
  "4) Call mcp__selected__lookup exactly once (use ToolSearch first if deferred).",
  "Do not invent inventory JSON as proof — the structured tool results are the proof.",
  "After the four tool calls, you may reply with a short acknowledgement.",
].join(" ");

function contentNoncesMatch(expectedNonces, observedNonces) {
  if (!expectedNonces) return true;
  if (!observedNonces || typeof observedNonces !== "object") return false;
  for (const key of ["skill", "plugin", "framework", "mcp"]) {
    if (expectedNonces[key] != null && observedNonces[key] !== expectedNonces[key]) {
      return false;
    }
  }
  return true;
}

function absentListComplete(absent) {
  if (!Array.isArray(absent)) return false;
  return ISOLATION_FORBIDDEN_CANARIES.every((name) => absent.includes(name));
}

/**
 * Create a run-specific Claude HOME containing only auth credentials.
 * Never copies ambient settings, MCP, skills, plugins, frameworks, hooks, or commands.
 * Does not log credential contents.
 */
export function createSanitizedClaudeHome({
  authSourceHome = os.homedir(),
  plantGlobalsFrom = null,
} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-claude-auth-home-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  const credSrc = path.join(authSourceHome, ".claude", ".credentials.json");
  if (fs.existsSync(credSrc)) {
    const dest = path.join(claudeDir, ".credentials.json");
    fs.copyFileSync(credSrc, dest);
    fs.chmodSync(dest, 0o600);
  }
  // Optionally plant ambient globals into this HOME so --bare must exclude them.
  if (plantGlobalsFrom && fs.existsSync(plantGlobalsFrom)) {
    const globalClaude = path.join(plantGlobalsFrom, ".claude");
    const globalJson = path.join(plantGlobalsFrom, ".claude.json");
    if (fs.existsSync(globalClaude)) {
      fs.cpSync(globalClaude, claudeDir, {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          // Never overwrite the auth-only credential we just placed.
          if (base === ".credentials.json") return false;
          return true;
        },
      });
      // Re-assert restrictive auth perms after copy.
      const cred = path.join(claudeDir, ".credentials.json");
      if (fs.existsSync(cred)) fs.chmodSync(cred, 0o600);
    }
    if (fs.existsSync(globalJson)) {
      fs.copyFileSync(globalJson, path.join(home, ".claude.json"));
    }
  }
  return home;
}

function buildObservedFromInitAndProof({
  init,
  toolProof,
  expected,
  capsule: _capsule,
  modelInventory = null,
}) {
  if (!init || !toolProof) return null;
  if (init.session_id && toolProof.session_id
    && init.session_id !== toolProof.session_id) {
    return null;
  }
  const mcpTools = (init.tools || []).filter((t) => String(t).startsWith("mcp__"));
  // Deferred MCP may only appear after ToolSearch; tool proof is authoritative
  // for the selected tool presence.
  if (!mcpTools.includes("mcp__selected__lookup")
    && toolProof.tool === "mcp__selected__lookup") {
    mcpTools.push("mcp__selected__lookup");
  }
  // Plugins come from structured init when --plugin-dir is honored.
  const plugins = [...(init.plugins || [])].filter((p) =>
    (expected?.plugins || []).includes(p)
  );
  if ((expected?.plugins || []).length && !plugins.length) return null;
  // Skills: structured live init and/or model inventory — never disk listings.
  const skillCandidates = [
    ...(init.skills || []),
    ...(Array.isArray(modelInventory?.skills) ? modelInventory.skills.map(String) : []),
  ];
  const skills = [...new Set(skillCandidates)].filter((s) =>
    (expected?.skills || []).includes(s)
  );
  if ((expected?.skills || []).length && !skills.length) return null;
  let frameworks = Array.isArray(modelInventory?.frameworks)
    ? modelInventory.frameworks.map(String).filter((f) =>
      (expected?.frameworks || []).includes(f)
    )
    : [...(init.frameworks || [])].filter((f) =>
      (expected?.frameworks || []).includes(f)
    );
  if ((expected?.frameworks || []).length && !frameworks.length) {
    return null;
  }

  const visible = new Set([
    ...skills,
    ...plugins,
    ...mcpTools,
    ...frameworks,
    ...(init.mcp_servers || []).map((n) => `mcp__${n}__*`),
  ]);
  const absent = ISOLATION_FORBIDDEN_CANARIES.filter((name) => {
    if (name.startsWith("mcp__")) {
      return !mcpTools.includes(name)
        && !(init.mcp_servers || []).some((s) => name.includes(`__${s}__`));
    }
    return !visible.has(name)
      && !(init.skills || []).includes(name)
      && !(init.plugins || []).includes(name);
  });

  // Live nonces only: MCP from tool_result; skill/plugin/framework from model
  // inventory that actually read selected content. Never fill from disk/config.
  const content_nonces = {
    mcp: toolProof.nonce,
  };
  const liveNonces = modelInventory?.content_nonces;
  if (liveNonces && typeof liveNonces === "object" && !Array.isArray(liveNonces)) {
    for (const key of ["skill", "plugin", "framework"]) {
      if (liveNonces[key] != null) content_nonces[key] = String(liveNonces[key]);
    }
  }

  return {
    skills,
    plugins: plugins.filter((p) => (expected?.plugins || []).includes(p)
      || p === "capsule.selected-plugin"),
    mcp_tools: mcpTools.filter((t) => t === "mcp__selected__lookup"
      || (expected?.mcp_tools || []).includes(t)),
    frameworks,
    absent,
    content_nonces,
    _init: init,
    _tool_proof: toolProof,
  };
}

/**
 * Live observation with sanitized auth-only HOME + strict selected config.
 * Negatives and positives come from structured init/tool inventory + tool proof.
 * Never uses `claude mcp list` as the isolated proof (it ignores isolation flags).
 */
export function collectLiveIsolationObservation({
  prepared,
  capsule,
  globalHome,
  expected = null,
  adapterId = "claude",
  spawnSyncFn,
  authSourceHome = os.homedir(),
} = {}) {
  if (typeof spawnSyncFn !== "function") return null;
  if (!prepared?.argv || !capsule) return null;

  if (adapterId === "codex") {
    return collectLiveCodexIsolationObservation({
      prepared,
      capsule,
      globalHome,
      expected,
      spawnSyncFn,
      authSourceHome,
    });
  }

  if (!globalHome || !globalsPlanted(globalHome, adapterId)) return null;

  const expectedNonces = expected?.nonces ?? capsule.nonces ?? null;
  const selectedToolName = (expected?.mcp_tools ?? ["mcp__selected__lookup"])[0];
  const mcpNonce = expectedNonces?.mcp;
  if (!selectedToolName || !mcpNonce) return null;

  const surface = collectLaunchIsolationObservation({ prepared, capsule, adapterId });
  if (!surface) return null;

  const pluginDirs = flagValues(prepared.argv, "--plugin-dir");
  if (!pluginDirs.length) return null;
  const mcpPath = flagValues(prepared.argv, "--mcp-config")[0];
  if (!mcpPath || !fs.existsSync(mcpPath)) return null;
  if (!prepared.argv.includes("--strict-mcp-config")) return null;
  // Production capsule launches set HOME to an auth-only run home (not --bare).
  const probeHome = prepared.env?.HOME;
  if (!probeHome || !fs.existsSync(path.join(probeHome, ".claude", ".credentials.json"))) {
    return null;
  }
  // Auth home must not contain planted ambient capabilities.
  if (fs.existsSync(path.join(probeHome, ".claude", "skills", "global.canary-skill"))) {
    return null;
  }
  if (fs.existsSync(path.join(probeHome, ".claude.json"))) {
    return null;
  }
  // Selected skills must be on the sanitized HOME surface Claude discovers.
  for (const skillName of expected?.skills || []) {
    if (!fs.existsSync(path.join(probeHome, ".claude", "skills", skillName))) {
      return null;
    }
  }

  const authHome = probeHome;
  const neutralDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-neutral-"));
  try {
    const addDirs = [...flagValues(prepared.argv, "--add-dir")];
    const toolsFlag = flagValues(prepared.argv, "--tools")[0]
      || flagValues(prepared.argv, "--allowedTools")[0];
    // Inventory probe uses the same HOME + flags as production (minus prompt).
    const inventoryArgv = [
      "claude",
      "--strict-mcp-config",
      "--mcp-config", mcpPath,
      ...pluginDirs.flatMap((dir) => ["--plugin-dir", dir]),
      ...addDirs.flatMap((dir) => ["--add-dir", dir]),
      ...(toolsFlag ? ["--tools", toolsFlag, "--allowedTools", toolsFlag] : []),
      "--disallowedTools", "Bash",
      "--print",
      "--verbose",
      "--output-format", "stream-json",
      INVENTORY_PROMPT,
    ];
    const inventoryRun = spawnSyncFn(inventoryArgv[0], inventoryArgv.slice(1), {
      encoding: "utf8",
      timeout: 180_000,
      cwd: neutralDir,
      env: { ...process.env, HOME: authHome },
    });
    if (inventoryRun.error) return null;
    const inventoryText = `${inventoryRun.stdout || ""}`;
    if (/not logged in|please run \/login/i.test(inventoryText)) return null;
    // stderr-only text cannot prove isolation.
    if (!inventoryRun.stdout) return null;

    const init = extractStructuredInitInventory(inventoryText);
    if (!init) return null;

    // Structured negatives: forbidden canaries must not appear in init inventory.
    for (const bad of ["global.canary-skill", "global.canary-plugin"]) {
      if ((init.skills || []).includes(bad) || (init.plugins || []).includes(bad)) {
        return null;
      }
    }
    if ((init.mcp_servers || []).includes("global")
      || (init.mcp_servers || []).includes("excluded")) {
      return null;
    }
    if ((init.tools || []).includes("mcp__global__canary")
      || (init.tools || []).includes("mcp__excluded__lookup")) {
      return null;
    }
    if (!(init.plugins || []).includes("capsule.selected-plugin")
      && !(init.tools || []).includes(selectedToolName)
      && !(init.tools || []).includes("ToolSearch")
      && !(init.tools || []).includes("Skill")) {
      return null;
    }

    // Full matrix proof comes from correlated Skill/plugin/Read/MCP events —
    // never from final model JSON inventory claims.
    const observed = parseClaudeStructuredCapabilityProofs(inventoryText, {
      expected,
      capsule,
    });
    if (!observed) return null;
    if (!observed.mcp_tools.includes("mcp__selected__lookup")) return null;
    if (!absentListComplete(observed.absent)) return null;
    if (!contentNoncesMatch(expectedNonces, observed.content_nonces)) return null;
    return observed;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(neutralDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Codex live isolation canary: sanitized CODEX_HOME (auth only + strict config),
 * selected skills/MCP from capsule, structured JSONL tool proof.
 */
export function collectLiveCodexIsolationObservation({
  prepared,
  capsule,
  globalHome,
  expected = null,
  spawnSyncFn,
  authSourceHome = os.homedir(),
} = {}) {
  if (typeof spawnSyncFn !== "function") return null;
  if (!prepared?.argv || !capsule?.codexHome) return null;
  if (!globalHome || !globalsPlanted(globalHome, "codex")) return null;

  const expectedNonces = expected?.nonces ?? capsule.nonces ?? null;
  const mcpNonce = expectedNonces?.mcp;
  if (!mcpNonce) return null;

  const authSrc = path.join(
    process.env.CODEX_HOME || path.join(authSourceHome, ".codex"),
    "auth.json"
  );
  if (!fs.existsSync(authSrc) && !fs.existsSync(path.join(capsule.codexHome, "auth.json"))) {
    return null;
  }

  // Ensure capsule home has auth only from source — no ambient config bleed.
  try {
    if (!fs.existsSync(path.join(capsule.codexHome, "auth.json")) && fs.existsSync(authSrc)) {
      fs.copyFileSync(authSrc, path.join(capsule.codexHome, "auth.json"));
      fs.chmodSync(path.join(capsule.codexHome, "auth.json"), 0o600);
    }
  } catch {
    return null;
  }

  const surface = collectLaunchIsolationObservation({
    prepared,
    capsule,
    adapterId: "codex",
  });
  if (!surface) return null;

  const neutralDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-codex-iso-"));
  try {
    const prompt = [
      "Call the selected MCP server tool named lookup exactly once.",
      "Then reply with ONLY one JSON object keys skills,plugins,mcp_tools,frameworks,absent,content_nonces.",
    ].join(" ");
    // Matches production capsule config.toml sandbox_mode=danger-full-access
    // (Codex 0.145.0 cancels MCP under read-only/workspace-write).
    const argv = [
      "codex", "exec",
      "--strict-config",
      "--skip-git-repo-check",
      "--json",
      "--sandbox", "danger-full-access",
      "-c", "approval_policy=never",
      prompt,
    ];
    const run = spawnSyncFn(argv[0], argv.slice(1), {
      encoding: "utf8",
      timeout: 180_000,
      cwd: neutralDir,
      env: {
        ...process.env,
        CODEX_HOME: capsule.codexHome,
        HOME: globalHome,
      },
      input: "",
    });
    if (run.error) return null;
    const text = `${run.stdout || ""}`;
    if (!text) return null;

    const proof = parseCodexJsonlToolProof(text, { nonce: mcpNonce });
    if (!proof) return null;

    const liveMcpTools = ["mcp__selected__lookup"];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") continue;
      let evt;
      try { evt = JSON.parse(trimmed); } catch { continue; }
      const item = evt?.item;
      if (item?.type !== "mcp_tool_call") continue;
      const server = String(item.server || "");
      const tool = String(item.tool || "").replace(/-/g, "_");
      if (server && tool) liveMcpTools.push(`mcp__${server}__${tool}`);
    }
    const uniqMcp = [...new Set(liveMcpTools)];
    if (uniqMcp.some((t) => /global|excluded/i.test(t))) return null;

    const capsuleSkills = listChildDirs([path.join(capsule.codexHome, "skills")]);
    if (capsuleSkills.includes("global.canary-skill")) return null;
    // Disk listing is a negative/presence gate only — never a live inventory source.
    if ((expected?.skills || []).includes("capsule.selected-skill")
      && !capsuleSkills.includes("capsule.selected-skill")) {
      return null;
    }
    // Full generic matrix requires native plugin/framework surfaces Codex lacks.
    if ((expected?.plugins || []).length > 0 || (expected?.frameworks || []).length > 0) {
      return null;
    }

    const modelInventory = parseIsolationObservationJson(
      extractCodexAgentMessageText(text)
    );
    if (!modelInventory) return null;
    if (modelInventory?.skills?.includes?.("global.canary-skill")) return null;
    if (modelInventory?.mcp_tools?.some?.((t) => /global|excluded/i.test(String(t)))) {
      return null;
    }

    const initLike = {
      session_id: proof.session_id,
      tools: uniqMcp,
      skills: Array.isArray(modelInventory?.skills)
        ? modelInventory.skills.map(String).filter((s) =>
          (expected?.skills || []).includes(s)
        )
        : [],
      plugins: Array.isArray(modelInventory?.plugins)
        ? modelInventory.plugins.map(String).filter((p) =>
          (expected?.plugins || []).includes(p)
        )
        : [],
      frameworks: Array.isArray(modelInventory?.frameworks)
        ? modelInventory.frameworks.map(String).filter((f) =>
          (expected?.frameworks || []).includes(f)
        )
        : [],
      mcp_servers: ["selected"],
    };
    if ((expected?.skills || []).length && !initLike.skills.length) return null;

    const observed = buildObservedFromInitAndProof({
      init: initLike,
      toolProof: {
        tool: "mcp__selected__lookup",
        nonce: mcpNonce,
        session_id: proof.session_id,
      },
      expected,
      capsule,
      modelInventory,
    });
    if (!observed) return null;
    if (!absentListComplete(observed.absent)) return null;
    if (!contentNoncesMatch(expectedNonces, observed.content_nonces)) return null;
    return observed;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(neutralDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function parseCodexJsonlToolProof(streamText, { nonce } = {}) {
  if (!streamText || !nonce) return null;
  const expectedPayload = `team-up-canary-ok:${nonce}`;
  let sessionId = null;
  let sawToolCall = false;
  let sawToolResult = false;
  for (const line of String(streamText).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (evt.type === "thread.started" && evt.thread_id) {
      sessionId = String(evt.thread_id);
    }
    const item = evt.item;
    if (!item || typeof item !== "object") continue;
    const itemType = String(item.type || "");
    if (itemType === "mcp_tool_call") {
      const server = String(item.server || "");
      const tool = String(item.tool || "");
      if (server === "selected" && /lookup/i.test(tool)) {
        if (item.status === "failed" || item.error) {
          return null;
        }
        if (item.status === "in_progress" || item.status === "completed") {
          sawToolCall = true;
        }
        // Only MCP result content proves the call — never model-echoed agent_message.
        if (item.status === "completed") {
          const content = item.result?.content;
          const text = Array.isArray(content)
            ? content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("")
            : (typeof item.result === "string" ? item.result : "");
          if (text === expectedPayload || text.trim() === expectedPayload) {
            sawToolResult = true;
          }
        }
      }
    }
  }
  if (!sessionId || !sawToolCall || !sawToolResult) return null;
  return {
    tool: "mcp__selected__lookup",
    nonce,
    session_id: sessionId,
  };
}

function extractCodexAgentMessageText(streamText) {
  const parts = [];
  for (const line of String(streamText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (evt?.item?.type === "agent_message" && typeof evt.item.text === "string") {
      parts.push(evt.item.text);
    }
  }
  return parts.join("\n");
}

export function decideContextIsolationCapability({ expected, observed } = {}) {
  if (!expected || !observed) return null;
  for (const key of ["skills", "plugins", "mcp_tools", "frameworks", "absent"]) {
    if (!Array.isArray(observed[key])) return null;
  }
  if (expected.nonces && !observed.content_nonces) return null;
  if (!absentListComplete(observed.absent)) return null;
  const result = validateIsolationObservation({ expected, observed });
  return result.ok ? CONTEXT_ISOLATION_CAPABILITY : null;
}

/**
 * prepareLaunch + live CLI observation. Token only when live report matches.
 * liveProbe may supply observed; null/error/missing observed fails closed.
 */
export function observeContextIsolation({
  adapter,
  adapterId = adapter?.id,
  spawnSyncFn = null,
  liveProbe = null,
  cleanup = true,
} = {}) {
  const fixture = buildIsolationCanaryFixture();
  const finish = (result) => {
    if (cleanup) {
      try { fixture.cleanup(); } catch { /* ignore */ }
      return { ...result, fixture: undefined };
    }
    return { ...result, fixture };
  };
  try {
    // Generic team-up.context-isolation/v1 always claims the full selected matrix.
    // Never shrink expected arrays to make a partial live surface look like a grant.
    const expected = { ...fixture.expected, nonces: { ...fixture.expected.nonces } };

    if (adapterId === "codex") {
      // Codex 0.145.0 lacks native plugin/framework isolation surfaces.
      // Keep declared context_isolation:null and do not grant generic v1.
      return finish({
        isolation_status: "unverified",
        context_isolation: null,
        expected,
        error: "codex lacks native plugin/framework surfaces for generic context-isolation/v1",
      });
    }

    let prepared;
    try {
      prepared = adapter.prepareLaunch({
        argv: ["claude", "--print", "--verbose", "--output-format", "stream-json", "isolation-probe"],
        runDir: fixture.runRoot,
        capsule: fixture.capsule,
        writeFileSync: fs.writeFileSync,
        mkdirSync: fs.mkdirSync,
        chmodSync: fs.chmodSync,
      });
    } catch (e) {
      return finish({
        isolation_status: "unverified",
        context_isolation: null,
        expected,
        error: e.message,
      });
    }

    const surface = collectLaunchIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      adapterId,
    });
    if (!surface) {
      return finish({
        isolation_status: "unverified",
        context_isolation: null,
        expected,
        error: "isolation launch surface incomplete or malformed",
        prepared,
      });
    }

    let observed = null;
    if (typeof liveProbe === "function") {
      const live = liveProbe({
        prepared,
        fixture,
        spawnSyncFn,
        surface,
        expected,
        globalHome: fixture.globalHome,
        ambientProject: fixture.ambientProject,
      });
      if (live == null) {
        return finish({
          isolation_status: "unverified",
          context_isolation: null,
          expected,
          error: "live isolation probe skipped or incomplete",
          prepared,
        });
      }
      if (live.error) {
        return finish({
          isolation_status: live.isolation_status || "unverified",
          context_isolation: null,
          expected,
          error: live.error,
          prepared,
        });
      }
      // Injected probes must still carry re-provable stream evidence.
      const selectedTool = (expected?.mcp_tools ?? ["mcp__selected__lookup"])[0];
      const mcpNonce = expected?.nonces?.mcp;
      if (!live.stream_text || !selectedTool || !mcpNonce) {
        return finish({
          isolation_status: "unverified",
          context_isolation: null,
          expected,
          error: "liveProbe missing stream_text or nonce for re-proof",
          prepared,
        });
      }
      const streamProof = parseClaudeStreamToolProof(live.stream_text, {
        toolName: selectedTool,
        nonce: mcpNonce,
      });
      if (!streamProof) {
        return finish({
          isolation_status: "unverified",
          context_isolation: null,
          expected,
          error: "liveProbe stream_text failed tool_use/tool_result re-proof",
          prepared,
        });
      }
      observed = live.observed ?? null;
    } else if (typeof spawnSyncFn === "function") {
      observed = collectLiveIsolationObservation({
        prepared,
        capsule: fixture.capsule,
        globalHome: fixture.globalHome,
        expected,
        adapterId,
        spawnSyncFn,
      });
    }

    if (!observed) {
      return finish({
        isolation_status: "unverified",
        context_isolation: null,
        expected,
        error: "live isolation observation missing, malformed, or skipped",
        prepared,
      });
    }

    const token = decideContextIsolationCapability({ expected, observed });
    return finish({
      isolation_status: token ? "passed" : "failed",
      context_isolation: token,
      observed,
      expected,
      prepared,
      error: token ? undefined : `isolation mismatch: ${JSON.stringify(observed)}`,
    });
  } catch (e) {
    return finish({
      isolation_status: "unverified",
      context_isolation: null,
      expected: fixture.expected,
      error: e.message,
    });
  }
}
