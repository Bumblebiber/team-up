import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeCapabilityCapsule, buildStrictMcpConfig } from "../capabilities/capsule.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "./capabilities.mjs";

export const ISOLATION_FORBIDDEN_CANARIES = Object.freeze([
  "global.canary-skill",
  "global.canary-plugin",
  "mcp__global__canary",
  "pool.unselected-skill",
  "mcp__excluded__lookup",
  "pool.unselected-framework",
]);

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
}) {
  const pkg = path.join(root, id);
  fs.mkdirSync(pkg, { recursive: true });
  const provides = { skills: [], plugins: [], frameworks: [], mcps: [] };
  for (const name of skills) {
    const rel = `skills/${name}/SKILL.md`;
    writeFile(path.join(pkg, rel), `# ${name}\ncanary skill\n`);
    provides.skills.push(rel);
  }
  for (const name of plugins) {
    const rel = `plugins/${name}`;
    writeFile(path.join(pkg, rel, "plugin.json"), JSON.stringify({
      name,
      version: "1.0.0",
      description: `canary plugin ${name}`,
    }, null, 2) + "\n");
    writeFile(path.join(pkg, rel, ".claude-plugin", "plugin.json"), JSON.stringify({
      name,
      version: "1.0.0",
    }, null, 2) + "\n");
    provides.plugins.push(rel);
  }
  for (const name of frameworks) {
    const rel = `frameworks/${name}/framework.json`;
    writeFile(path.join(pkg, rel), JSON.stringify({
      name,
      version: "1.0.0",
      description: `canary framework ${name}`,
    }, null, 2) + "\n");
    provides.frameworks.push(rel);
  }
  for (const mcp of mcps) {
    const rel = `mcps/${mcp.server}/mcp.json`;
    writeFile(path.join(pkg, rel), JSON.stringify({
      tools: mcp.tools,
      mcpServers: {
        [mcp.server]: {
          type: "stdio",
          command: process.execPath,
          args: ["-e", `process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{tools:[]}}))`],
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
  const pool = path.join(root, "pool");
  const runRoot = path.join(root, "run");
  fs.mkdirSync(runRoot, { recursive: true });

  writeFile(
    path.join(globalHome, ".claude", "skills", "global.canary-skill", "SKILL.md"),
    "# global.canary-skill\n"
  );
  writeFile(
    path.join(globalHome, ".claude", "plugins", "global.canary-plugin", "plugin.json"),
    JSON.stringify({ name: "global.canary-plugin", version: "1.0.0" }, null, 2) + "\n"
  );
  writeFile(
    path.join(globalHome, ".claude", ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        global: {
          type: "stdio",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          tools: ["canary"],
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
  });
  const selectedPlugin = writePackage(pool, {
    id: "fixture.selected-plugin",
    plugins: ["capsule.selected-plugin"],
  });
  const selectedMcp = writePackage(pool, {
    id: "fixture.selected-mcp",
    mcps: [{ server: "selected", tools: ["lookup"] }],
  });
  const selectedFramework = writePackage(pool, {
    id: "fixture.selected-framework",
    frameworks: ["capsule.selected-framework"],
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
    ...mcpBits,
  };

  const expected = {
    skills: ["capsule.selected-skill"],
    plugins: ["capsule.selected-plugin"],
    mcp_tools: ["mcp__selected__lookup"],
    frameworks: ["capsule.selected-framework"],
  };
  const codexExpected = {
    skills: ["capsule.selected-skill"],
    plugins: [],
    mcp_tools: ["mcp__selected__lookup"],
    frameworks: [],
  };

  return {
    root,
    globalHome,
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
    // Prefer a fenced or trailing JSON object in model output.
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
  return {
    skills: obj.skills.map(String),
    plugins: obj.plugins.map(String),
    mcp_tools: obj.mcp_tools.map(String),
    frameworks: obj.frameworks.map(String),
    absent: obj.absent.map(String),
  };
}

/**
 * Deterministic observation of what a prepared capsule launch exposes.
 * Returns null when the launch surface is incomplete/malformed.
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
    // Selected MCP tool must be present for a complete observation.
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

export function decideContextIsolationCapability({ expected, observed } = {}) {
  if (!expected || !observed) return null;
  for (const key of ["skills", "plugins", "mcp_tools", "frameworks", "absent"]) {
    if (!Array.isArray(observed[key])) return null;
  }
  const result = validateIsolationObservation({ expected, observed });
  return result.ok ? CONTEXT_ISOLATION_CAPABILITY : null;
}

/**
 * Run capsule prepareLaunch + observation. Optional liveProbe may further
 * reject isolation when the executable reports a conflicting inventory.
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
      try {
        fixture.cleanup();
      } catch {
        // ignore
      }
      return { ...result, fixture: undefined };
    }
    return { ...result, fixture };
  };
  try {
    const expected = adapterId === "codex" ? fixture.codexExpected : fixture.expected;
    let prepared;
    try {
      if (adapterId === "claude") {
        prepared = adapter.prepareLaunch({
          argv: ["claude", "--print", "--output-format", "text", "isolation-probe"],
          runDir: fixture.runRoot,
          capsule: fixture.capsule,
          writeFileSync: fs.writeFileSync,
          mkdirSync: fs.mkdirSync,
          chmodSync: fs.chmodSync,
        });
      } else {
        prepared = adapter.prepareLaunch({
          argv: ["codex", "exec", "--skip-git-repo-check", "isolation-probe"],
          runDir: fixture.runRoot,
          capsule: fixture.capsule,
          authSource: path.join(
            process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
            "auth.json"
          ),
        });
      }
    } catch (e) {
      return finish({
        isolation_status: "unverified",
        context_isolation: null,
        error: e.message,
      });
    }

    let observed = collectLaunchIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      adapterId,
    });
    if (!observed) {
      return finish({
        isolation_status: "unverified",
        context_isolation: null,
        error: "isolation observation incomplete or malformed",
        prepared,
      });
    }

    if (typeof liveProbe === "function") {
      const live = liveProbe({ prepared, fixture, spawnSyncFn, observed, expected });
      if (live == null) {
        return finish({
          isolation_status: "unverified",
          context_isolation: null,
          error: "live isolation probe skipped or incomplete",
          observed,
          prepared,
        });
      }
      if (live.error) {
        return finish({
          isolation_status: live.isolation_status || "unverified",
          context_isolation: null,
          error: live.error,
          observed,
          prepared,
        });
      }
      if (live.observed) observed = live.observed;
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
