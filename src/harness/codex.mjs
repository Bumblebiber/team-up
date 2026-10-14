import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_DECLARED_CAPABILITIES } from "./capabilities.mjs";
import { captureCodexToolInventory } from "./codex-inventory.mjs";

export const CODEX_SHELL_DISABLE_FLAG = Object.freeze(["--disable", "shell_tool"]);

/**
 * Insert `--disable shell_tool` before the `--` separator so argv overrides
 * survive a repo `.codex/config.toml` that re-enables the shell.
 */
export function appendCodexShellDisable(argv) {
  const next = [...argv];
  if (next.some((a, i) => a === "--disable" && next[i + 1] === "shell_tool")) {
    return next;
  }
  const dash = next.indexOf("--");
  const tail = dash < 0 ? [] : next.splice(dash);
  next.push(...CODEX_SHELL_DISABLE_FLAG, ...tail);
  return next;
}

export const codexAdapter = {
  id: "codex",
  capabilities: CODEX_DECLARED_CAPABILITIES,

  version({ execFileSync }) {
    const text = String(
      execFileSync("codex", ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
      })
    ).trim();
    return text.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? text;
  },

  prepareLaunch({
    argv,
    capsule,
    authSource = path.join(
      process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
      "auth.json"
    ),
    writeFileSync = fs.writeFileSync,
    mkdirSync = fs.mkdirSync,
    chmodSync = fs.chmodSync,
  }) {
    if (!capsule?.codexHome) throw new Error("CODEX_CAPSULE_REQUIRED");
    mkdirSync(capsule.codexHome, { recursive: true });
    mkdirSync(path.join(capsule.codexHome, "skills"), { recursive: true });
    for (const source of capsule.skillDirs ?? []) {
      if (!source || !fs.existsSync(source)) continue;
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        fs.cpSync(
          path.join(source, entry.name),
          path.join(capsule.codexHome, "skills", entry.name),
          { recursive: true, errorOnExist: true }
        );
      }
    }
    const quote = (value) => JSON.stringify(String(value));
    const lines = [];
    for (const [name, server] of Object.entries(capsule.mcpConfig?.mcpServers ?? {}).sort(
      ([a], [b]) => a.localeCompare(b)
    )) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error(`invalid Codex MCP name: ${name}`);
      }
      lines.push(`[mcp_servers.${name}]`);
      lines.push(`command = ${quote(server.command)}`);
      lines.push(`args = [${(server.args ?? []).map(quote).join(", ")}]`);
      if (server.env && Object.keys(server.env).length > 0) {
        const env = Object.entries(server.env)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${quote(key)} = ${quote(value)}`)
          .join(", ");
        lines.push(`env = { ${env} }`);
      }
      lines.push("");
    }
    const config = `${lines.join("\n")}\n`;
    writeFileSync(path.join(capsule.codexHome, "config.toml"), config);
    if (authSource && fs.existsSync(authSource)) {
      fs.copyFileSync(authSource, path.join(capsule.codexHome, "auth.json"));
      chmodSync(path.join(capsule.codexHome, "auth.json"), 0o600);
    }
    const withStrict = argv.includes("--strict-config") ? [...argv] : [...argv, "--strict-config"];
    const next = appendCodexShellDisable(withStrict);
    return {
      argv: next,
      env: { CODEX_HOME: capsule.codexHome },
      files: [
        path.join(capsule.codexHome, "config.toml"),
        ...(fs.existsSync(path.join(capsule.codexHome, "auth.json"))
          ? [path.join(capsule.codexHome, "auth.json")]
          : []),
      ],
    };
  },

  /**
   * Resolved tool map from a fake Responses server capture (no billing).
   */
  toolInventory({ env = {} } = {}) {
    const codexHome = env.CODEX_HOME;
    if (!codexHome) throw new Error("CODEX_HOME required for tool inventory");
    return captureCodexToolInventory({ codexHome });
  },
};
