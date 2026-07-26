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
      contentNonceField(`# ${name}\ncanary skill`, nonce)
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
 * Parse genuine stream-json tool_use/tool_result proof for the selected MCP tool.
 */
export function parseClaudeStreamToolProof(streamText, { toolName, nonce } = {}) {
  if (!streamText || !toolName || !nonce) return null;
  let sawToolUse = false;
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
    const inspectBlock = (block) => {
      if (!block || typeof block !== "object") return;
      if (block.type === "tool_use" && block.name === toolName) {
        sawToolUse = true;
      }
      if (block.type === "tool_result") {
        const text = toolResultText(block.content);
        if (text.includes(nonce)) sawToolResult = true;
      }
    };
    if (evt.type === "tool_use" && evt.name === toolName) sawToolUse = true;
    if (evt.type === "tool_result") {
      const text = toolResultText(evt.content);
      if (text.includes(nonce)) sawToolResult = true;
    }
    const content = evt.message?.content || evt.content;
    if (Array.isArray(content)) {
      for (const block of content) inspectBlock(block);
    }
  }
  if (!sawToolUse || !sawToolResult) return null;
  return { tool: toolName, nonce };
}

function extractInventoryFromStream(streamText) {
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
  return parseIsolationObservationJson(streamText);
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
    if (adapterId === "claude" && !prepared.argv.includes("--bare")) return null;
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
  "First call the mcp__selected__lookup tool exactly once.",
  "Then reply with ONLY one JSON object and no prose.",
  "Keys: skills, plugins, mcp_tools, frameworks, absent, content_nonces.",
  "content_nonces maps skill/plugin/framework/mcp to unpredictable nonce strings found in their content.",
  "List only capabilities you can actually use in this session.",
  "Include mcp__selected__lookup in mcp_tools if that tool is available.",
  "absent must include every forbidden canary you cannot use.",
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
 * Live observation against planted ambient canaries.
 * Never grants from disk/config assertions alone. Codex is fail-closed (null)
 * until full selected/global/unselected/excluded coverage exists.
 */
export function collectLiveIsolationObservation({
  prepared,
  capsule,
  globalHome,
  expected = null,
  adapterId = "claude",
  spawnSyncFn,
} = {}) {
  if (typeof spawnSyncFn !== "function") return null;
  if (!prepared?.argv || !capsule || !globalHome) return null;
  if (adapterId === "codex") return null;
  if (!globalsPlanted(globalHome, adapterId)) return null;

  const expectedNonces = expected?.nonces ?? capsule.nonces ?? null;
  const selectedToolName = (expected?.mcp_tools ?? ["mcp__selected__lookup"])[0];
  const mcpNonce = expectedNonces?.mcp;
  if (!selectedToolName || !mcpNonce) return null;

  const surface = collectLaunchIsolationObservation({ prepared, capsule, adapterId });
  if (!surface) return null;

  try {
    const configFormat = detectClaudeUserMcpConfigFormat({ spawnSyncFn });
    if (configFormat !== "claude.json") return null;
    if (!readClaudeJsonMcpServers(globalHome)?.global) return null;

    const pluginDirs = flagValues(prepared.argv, "--plugin-dir");
    if (!pluginDirs.length) return null;
    const mcpPath = flagValues(prepared.argv, "--mcp-config")[0];
    if (!mcpPath || !fs.existsSync(mcpPath)) return null;
    if (!prepared.argv.includes("--strict-mcp-config") || !prepared.argv.includes("--bare")) {
      return null;
    }

    const neutralDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-neutral-"));
    try {
      const positive = spawnSyncFn("claude", ["mcp", "list"], {
        encoding: "utf8",
        timeout: 30_000,
        cwd: neutralDir,
        env: { ...process.env, HOME: globalHome },
      });
      if (positive.error || positive.status !== 0) return null;
      const positiveServers = parseClaudeMcpList(
        `${positive.stdout || ""}\n${positive.stderr || ""}`
      );
      if (!positiveServers.includes("global")) return null;

      const isolatedListArgv = [
        "claude", "--bare", "--strict-mcp-config",
        "--mcp-config", mcpPath,
        ...pluginDirs.flatMap((dir) => ["--plugin-dir", dir]),
        "mcp", "list",
      ];
      const isolatedList = spawnSyncFn(
        isolatedListArgv[0],
        isolatedListArgv.slice(1),
        {
          encoding: "utf8",
          timeout: 30_000,
          cwd: neutralDir,
          env: { ...process.env, HOME: globalHome },
        }
      );
      if (isolatedList.error || isolatedList.status !== 0) return null;
      const isolatedServers = parseClaudeMcpList(
        `${isolatedList.stdout || ""}\n${isolatedList.stderr || ""}`
      );
      if (isolatedServers.includes("global")) return null;

      const pluginArgv = [
        "claude", "--bare",
        ...pluginDirs.flatMap((dir) => ["--plugin-dir", dir]),
        "plugin", "list",
      ];
      const pluginRun = spawnSyncFn(pluginArgv[0], pluginArgv.slice(1), {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: globalHome },
      });
      if (pluginRun.error || pluginRun.status !== 0) return null;
      const livePlugins = parseClaudePluginList(
        `${pluginRun.stdout || ""}\n${pluginRun.stderr || ""}`,
        { sessionOnly: true }
      );
      if (!livePlugins.includes("capsule.selected-plugin")) return null;
      if (livePlugins.includes("global.canary-plugin")) return null;

      const addDirs = [...flagValues(prepared.argv, "--add-dir")];
      const inventoryArgv = [
        "claude",
        "--bare",
        "--strict-mcp-config",
        "--mcp-config", mcpPath,
        ...pluginDirs.flatMap((dir) => ["--plugin-dir", dir]),
        ...addDirs.flatMap((dir) => ["--add-dir", dir]),
        "--print",
        "--output-format", "stream-json",
        INVENTORY_PROMPT,
      ];
      const inventoryRun = spawnSyncFn(inventoryArgv[0], inventoryArgv.slice(1), {
        encoding: "utf8",
        timeout: 120_000,
        cwd: neutralDir,
        env: { ...process.env, HOME: globalHome },
      });
      if (inventoryRun.error || inventoryRun.status !== 0) return null;
      const inventoryText = `${inventoryRun.stdout || ""}\n${inventoryRun.stderr || ""}`;
      if (/not logged in|please run \/login/i.test(inventoryText)) return null;

      const toolProof = parseClaudeStreamToolProof(inventoryText, {
        toolName: selectedToolName,
        nonce: mcpNonce,
      });
      if (!toolProof) return null;

      const observed = extractInventoryFromStream(inventoryText);
      if (!observed) return null;
      if (!observed.mcp_tools.includes("mcp__selected__lookup")) return null;
      if (observed.mcp_tools.includes("mcp__global__canary")) return null;
      if (observed.mcp_tools.includes("mcp__excluded__lookup")) return null;
      if (!observed.plugins.includes("capsule.selected-plugin")) return null;
      if (observed.plugins.includes("global.canary-plugin")) return null;
      if (!absentListComplete(observed.absent)) return null;
      if (!contentNoncesMatch(expectedNonces, observed.content_nonces)) return null;

      return observed;
    } finally {
      try { fs.rmSync(neutralDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch {
    return null;
  }
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
    if (adapterId === "codex") {
      return finish({
        isolation_status: "unverified",
        context_isolation: null,
        error: "codex context isolation canary incomplete; refusing partial token",
      });
    }
    const expected = fixture.expected;
    let prepared;
    try {
      prepared = adapter.prepareLaunch({
        argv: ["claude", "--print", "--output-format", "text", "isolation-probe"],
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
          error: "live isolation probe skipped or incomplete",
          prepared,
        });
      }
      if (live.error) {
        return finish({
          isolation_status: live.isolation_status || "unverified",
          context_isolation: null,
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
        expected: fixture.expected,
        adapterId,
        spawnSyncFn,
      });
    }

    if (!observed) {
      return finish({
        isolation_status: "unverified",
        context_isolation: null,
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
      error: e.message,
    });
  }
}
