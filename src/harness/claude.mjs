import { CLAUDE_DECLARED_CAPABILITIES, UNVERIFIED_CAPABILITIES } from "./capabilities.mjs";

export const claudeAdapter = {
  id: "claude",
  capabilities: CLAUDE_DECLARED_CAPABILITIES,

  sanitizeBrokeredArgv(argv) {
    const next = [];
    for (let i = 0; i < argv.length; i++) {
      if (
        argv[i] === "--dangerously-skip-permissions" ||
        argv[i] === "--allow-dangerously-skip-permissions"
      ) {
        continue;
      }
      if (argv[i] === "--permission-mode" && argv[i + 1] === "bypassPermissions") {
        i++;
        continue;
      }
      next.push(argv[i]);
    }
    return next;
  },

  version({ execFileSync }) {
    const out = execFileSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const text = String(out).trim();
    // Prefer leading semver: "2.1.220 (Claude Code)"
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
    allowedBuiltins = ["Read", "Edit", "Write", "Glob", "Grep"],
    nodePath = process.execPath,
    brokerBin,
    writeFileSync,
    mkdirSync,
    chmodSync,
  }) {
    const forbidden = [
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
    ];
    for (const flag of forbidden) {
      if (argv.includes(flag)) {
        const err = new Error(`HARNESS_POLICY: refusing ${flag}`);
        err.code = "HARNESS_POLICY";
        throw err;
      }
    }
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--permission-mode" && argv[i + 1] === "bypassPermissions") {
        const err = new Error("HARNESS_POLICY: refusing --permission-mode bypassPermissions");
        err.code = "HARNESS_POLICY";
        throw err;
      }
    }

    const harnessDir = `${runDir}/harness`;
    mkdirSync(harnessDir, { recursive: true });
    const mcpPath = `${harnessDir}/claude-mcp.json`;
    try {
      chmodSync(mcpPath, 0o644);
    } catch {
      // first write — file may not exist
    }
    // Capsule servers first, then the broker: the broker name is reserved and
    // must never be shadowed by a capability package.
    const mcpServers = { ...(capsule?.mcpConfig?.mcpServers ?? {}) };
    if (mcpServers.team_up_command_broker) {
      const err = new Error(
        "HARNESS_POLICY: capability package may not define team_up_command_broker"
      );
      err.code = "HARNESS_POLICY";
      throw err;
    }
    if (broker) {
      mcpServers.team_up_command_broker = {
        type: "stdio",
        command: nodePath,
        args: [brokerBin],
        env: {
          TEAM_UP_COMMAND_POLICY_SNAPSHOT: broker.policySnapshot,
          TEAM_UP_COMMAND_POLICY_CHECKSUM: broker.policyChecksum,
          TEAM_UP_PROJECT: broker.project,
          TEAM_UP_RUN_DIR: broker.runDir,
        },
      };
    }
    writeFileSync(mcpPath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, {
      mode: 0o644,
    });
    try {
      chmodSync(mcpPath, 0o444);
    } catch {
      // best-effort immutable mode
    }

    const brokerTools = (broker?.actionIds || []).map(
      (id) => `mcp__team_up_command_broker__${String(id).replace(/-/g, "_")}`
    );
    // Selected MCP tools only. An absent tool list allows the capsule server's
    // own tools and nothing else; global MCP names never appear here.
    const capsuleTools =
      capsule?.mcpToolNames ??
      Object.keys(capsule?.mcpConfig?.mcpServers ?? {}).map((name) => `mcp__${name}`);
    const tools = [...allowedBuiltins, ...capsuleTools, ...brokerTools].join(",");

    const next = [...argv];
    if (capsule) {
      // `--bare` also refuses OAuth and keychain auth, so it stays opt-in for
      // API-key launches; subscription launches isolate via CLAUDE_CONFIG_DIR.
      if (capsule.bare && !next.includes("--bare")) next.push("--bare");
      for (const pluginDir of capsule.pluginDirs ?? []) {
        next.push("--plugin-dir", pluginDir);
      }
    }
    if (!next.includes("--strict-mcp-config")) next.push("--strict-mcp-config");
    next.push("--mcp-config", mcpPath);
    next.push("--tools", tools);
    // Pre-approve the allowlisted tools so live verify/MCP calls do not stall
    // on interactive permission prompts — without bypassing all permissions.
    next.push("--allowedTools", tools);
    if (broker) next.push("--disallowedTools", "Bash");

    const env = {};
    // A run-specific config dir keeps user-global skills, plugins, settings and
    // hooks out of the worker. Auth is bridged into it separately.
    if (capsule?.homeDir) env.CLAUDE_CONFIG_DIR = capsule.homeDir;

    return {
      argv: next,
      env,
      files: [mcpPath],
    };
  },
};
