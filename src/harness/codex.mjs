import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const codexAdapter = {
  id: "codex",
  capabilities: {
    command_broker: null,
    context_isolation: "team-up.context-isolation/v1",
    native_shell: "unverified",
    mcp: "stdio",
  },

  version({ execFileSync }) {
    const text = String(execFileSync("codex", ["--version"], {
      encoding: "utf8", timeout: 10_000,
    })).trim();
    return text.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? text;
  },

  prepareLaunch({
    argv, capsule, authSource = path.join(
      process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
      "auth.json"
    ),
  }) {
    if (!capsule?.codexHome) throw new Error("CODEX_CAPSULE_REQUIRED");
    fs.mkdirSync(capsule.codexHome, { recursive: true });
    fs.mkdirSync(path.join(capsule.codexHome, "skills"), { recursive: true });
    for (const source of capsule.skillDirs ?? []) {
      if (!fs.existsSync(source)) continue;
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        fs.cpSync(path.join(source, entry.name),
          path.join(capsule.codexHome, "skills", entry.name),
          { recursive: true, errorOnExist: true });
      }
    }
    const quote = (value) => JSON.stringify(String(value));
    // Codex 0.145.0 cancels non-interactive MCP under read-only/workspace-write
    // even with approval_policy=never. Capsule launches that include MCP must
    // use danger-full-access so live tool proof matches production config.
    const lines = [
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      "",
    ];
    for (const [name, server] of Object.entries(
      capsule.mcpConfig?.mcpServers ?? {}
    ).sort(([a], [b]) => a.localeCompare(b))) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error(`invalid Codex MCP name: ${name}`);
      }
      lines.push(`[mcp_servers.${name}]`);
      lines.push(`command = ${quote(server.command)}`);
      lines.push(`args = [${(server.args ?? []).map(quote).join(", ")}]`);
      if (server.env && Object.keys(server.env).length > 0) {
        const env = Object.entries(server.env).sort(([a], [b]) =>
          a.localeCompare(b)).map(([key, value]) =>
          `${quote(key)} = ${quote(value)}`).join(", ");
        lines.push(`env = { ${env} }`);
      }
      lines.push("");
    }
    const config = `${lines.join("\n")}\n`;
    fs.writeFileSync(path.join(capsule.codexHome, "config.toml"), config);
    if (authSource && fs.existsSync(authSource)) {
      fs.copyFileSync(authSource, path.join(capsule.codexHome, "auth.json"));
      fs.chmodSync(path.join(capsule.codexHome, "auth.json"), 0o600);
    }
    const next = argv.includes("--strict-config")
      ? [...argv] : [...argv, "--strict-config"];
    return {
      argv: next,
      env: { CODEX_HOME: capsule.codexHome },
      files: [
        path.join(capsule.codexHome, "config.toml"),
        ...(fs.existsSync(path.join(capsule.codexHome, "auth.json"))
          ? [path.join(capsule.codexHome, "auth.json")] : []),
      ],
    };
  },
};
