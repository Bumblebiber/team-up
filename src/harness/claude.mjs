import { CLAUDE_DECLARED_CAPABILITIES } from "./capabilities.mjs";

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
    broker = null,
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

    const mcpServers = {
      ...(capsule?.mcpConfig?.mcpServers ?? {}),
      ...(broker ? {
        team_up_command_broker: {
          type: "stdio",
          command: nodePath,
          args: [brokerBin],
          env: {
            TEAM_UP_COMMAND_POLICY_SNAPSHOT: broker.policySnapshot,
            TEAM_UP_COMMAND_POLICY_CHECKSUM: broker.policyChecksum,
            TEAM_UP_PROJECT: broker.project,
            TEAM_UP_RUN_DIR: broker.runDir,
          },
        },
      } : {}),
    };
    const mcpConfig = { mcpServers };
    writeFileSync(mcpPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, { mode: 0o644 });
    try {
      chmodSync(mcpPath, 0o444);
    } catch {
      // best-effort immutable mode
    }

    const brokerTools = broker
      ? (broker.actionIds || []).map(
        (id) => `mcp__team_up_command_broker__${String(id).replace(/-/g, "_")}`
      )
      : [];
    const mcpTools = capsule?.mcpToolNames ?? Object.keys(mcpServers)
      .filter((name) => name !== "team_up_command_broker")
      .flatMap((name) => (capsule?.mcpToolsByServer?.[name] ?? []).map(
        (tool) => `mcp__${name}__${String(tool).replace(/-/g, "_")}`
      ));
    const tools = [...allowedBuiltins, ...brokerTools, ...mcpTools].join(",");

    const next = [...argv];
    if (capsule && !next.includes("--bare")) next.push("--bare");
    for (const pluginDir of capsule?.pluginDirs ?? []) {
      next.push("--plugin-dir", pluginDir);
    }
    if (!next.includes("--strict-mcp-config")) next.push("--strict-mcp-config");
    next.push("--mcp-config", mcpPath);
    next.push("--tools", tools);
    next.push("--allowedTools", tools);
    next.push("--disallowedTools", "Bash");

    return {
      argv: next,
      env: {},
      files: [mcpPath],
    };
  },
};
