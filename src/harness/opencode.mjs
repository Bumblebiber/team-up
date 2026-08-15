import fs from "node:fs";
import path from "node:path";
import { OPENCODE_DECLARED_CAPABILITIES } from "./capabilities.mjs";

/**
 * Symlink the capsule's skill directories into the layout opencode discovers.
 *
 * The Claude adapter copies skills into its sanitized HOME instead; opencode
 * reads them from its config dir, so this is the only consumer. Colliding skill
 * names are an error rather than a silent last-one-wins.
 */
function linkCapsuleSkills({
  homeDir,
  skillDirs = [],
  mkdirSync = fs.mkdirSync,
  readdirSync = fs.readdirSync,
  symlinkSync = fs.symlinkSync,
  rmSync = fs.rmSync,
} = {}) {
  if (!homeDir) return [];
  const target = path.join(homeDir, "skills");
  rmSync(target, { recursive: true, force: true });
  const linked = [];
  const seen = new Map();
  for (const dir of skillDirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const previous = seen.get(entry.name);
      if (previous) {
        const err = new Error(
          `HARNESS_SKILL_COLLISION: ${entry.name} provided by ${previous} and ${dir}`
        );
        err.code = "HARNESS_SKILL_COLLISION";
        throw err;
      }
      seen.set(entry.name, dir);
      mkdirSync(target, { recursive: true });
      const link = path.join(target, entry.name);
      symlinkSync(path.join(dir, entry.name), link);
      linked.push(link);
    }
  }
  return linked;
}

/**
 * Environment that makes opencode forget the user's global setup.
 *
 * `XDG_CONFIG_HOME` is the only lever that actually isolates: redirecting
 * `OPENCODE_CONFIG_DIR` or `OPENCODE_CONFIG` still loads the user's global MCP
 * servers (measured: 51 leaked tool names). Auth survives the redirect because
 * it lives under `XDG_DATA_HOME`, so an isolated launch stays logged in.
 *
 * The two skill flags are load-bearing on top of that: by default opencode also
 * reads Claude Code's skill tree, which put 80 user-global skills in front of a
 * worker that had selected none of them.
 */
export function opencodeIsolationEnv(configHome) {
  return {
    XDG_CONFIG_HOME: configHome,
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  };
}

/**
 * Translate a broker and capsule MCP servers into opencode's config shape.
 *
 * opencode exposes tools as `<serverName>_<toolName>`, so the broker's reserved
 * name may never be taken by a capability package.
 */
export function buildOpencodeMcp({ broker, capsule, nodePath, brokerBin }) {
  const mcp = {};
  for (const [name, spec] of Object.entries(capsule?.mcpConfig?.mcpServers ?? {})) {
    if (name === "team_up_command_broker") {
      const err = new Error(
        "HARNESS_POLICY: capability package may not define team_up_command_broker"
      );
      err.code = "HARNESS_POLICY";
      throw err;
    }
    // Claude's stdio shape carries command + args; opencode takes one array.
    mcp[name] = {
      type: "local",
      command: [spec.command, ...(spec.args ?? [])],
      ...(spec.env ? { environment: spec.env } : {}),
    };
  }
  if (broker) {
    mcp.team_up_command_broker = {
      type: "local",
      command: [nodePath, brokerBin],
      environment: {
        TEAM_UP_COMMAND_POLICY_SNAPSHOT: broker.policySnapshot,
        TEAM_UP_COMMAND_POLICY_CHECKSUM: broker.policyChecksum,
        TEAM_UP_PROJECT: broker.project,
        TEAM_UP_RUN_DIR: broker.runDir,
      },
    };
  }
  return mcp;
}

export const opencodeAdapter = {
  id: "opencode",
  capabilities: OPENCODE_DECLARED_CAPABILITIES,

  version({ execFileSync }) {
    const out = execFileSync("opencode", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const text = String(out).trim();
    const m = text.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)\b/);
    return m ? m[1] : text.split(/\s+/)[0] || text;
  },

  injectControl({ tmuxSession, message, execFileSync }) {
    execFileSync("tmux", ["send-keys", "-t", tmuxSession, "-l", message], {
      stdio: "ignore",
    });
    execFileSync("tmux", ["send-keys", "-t", tmuxSession, "Enter"], {
      stdio: "ignore",
    });
  },

  prepareLaunch({
    argv,
    runDir,
    broker,
    capsule = null,
    nodePath = process.execPath,
    brokerBin,
    writeFileSync,
    mkdirSync,
    chmodSync,
    readdirSync = fs.readdirSync,
    symlinkSync = fs.symlinkSync,
    rmSync = fs.rmSync,
  }) {
    // `--pure` only drops external plugins; it leaves the global MCP servers and
    // skill trees in place, so accepting it would suggest an isolation it does
    // not provide.
    if (argv.includes("--pure")) {
      const err = new Error("HARNESS_POLICY: --pure does not isolate; refusing");
      err.code = "HARNESS_POLICY";
      throw err;
    }

    const configHome = capsule?.configHome ?? path.join(runDir, "harness", "config");
    const appDir = path.join(configHome, "opencode");
    mkdirSync(appDir, { recursive: true });

    const configPath = path.join(appDir, "opencode.json");
    try {
      chmodSync(configPath, 0o644);
    } catch {
      // first write — file may not exist
    }

    const config = {
      $schema: "https://opencode.ai/config.json",
      // Denying a tool removes it from the worker's tool list rather than
      // prompting for it, which is what native_shell: denied means here.
      permission: { bash: "deny" },
      mcp: buildOpencodeMcp({ broker, capsule, nodePath, brokerBin }),
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
    try {
      chmodSync(configPath, 0o444);
    } catch {
      // best-effort immutable mode
    }

    // Skills are discovered from `<config>/opencode/skills/<name>/SKILL.md`,
    // the same layout the Claude adapter links into its config dir.
    const linkedSkills = capsule
      ? linkCapsuleSkills({
          homeDir: appDir,
          skillDirs: capsule.skillDirs ?? [],
          mkdirSync,
          readdirSync,
          symlinkSync,
          rmSync,
        })
      : [];

    return {
      argv: [...argv],
      env: opencodeIsolationEnv(configHome),
      files: [configPath],
      linkedSkills,
    };
  },
};
