import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

function homeChecksum(homePath) {
  const hash = crypto.createHash("sha256");
  const stack = [homePath];
  const files = [];
  while (stack.length) {
    const current = stack.pop();
    let st;
    try {
      st = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(current).sort()) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (st.isFile()) files.push(current);
  }
  for (const file of files.sort()) {
    hash.update(path.relative(homePath, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function cleanAbandonedCodexStaging(parentDir, keepName) {
  let entries = [];
  try {
    entries = fs.readdirSync(parentDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(".codex-home-staging-")) continue;
    if (entry === keepName) continue;
    try {
      fs.rmSync(path.join(parentDir, entry), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export const codexAdapter = {
  id: "codex",
  capabilities: {
    command_broker: null,
    // Codex 0.145.0 has no native plugin/framework isolation surfaces for the
    // full generic matrix — declare null so verify stays fail-closed.
    context_isolation: null,
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
    const generationId = crypto.randomBytes(8).toString("hex");
    const parentDir = path.dirname(capsule.codexHome);
    fs.mkdirSync(parentDir, { recursive: true });
    const stagingName = `.codex-home-staging-${generationId}`;
    const staging = path.join(parentDir, stagingName);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(path.join(staging, "skills"), { recursive: true });

    for (const source of capsule.skillDirs ?? []) {
      if (!fs.existsSync(source)) continue;
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        fs.cpSync(
          path.join(source, entry.name),
          path.join(staging, "skills", entry.name),
          { recursive: true, errorOnExist: true }
        );
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
    fs.writeFileSync(path.join(staging, "config.toml"), config);
    if (authSource && fs.existsSync(authSource)) {
      const st = fs.lstatSync(authSource);
      if (!st.isSymbolicLink() && st.isFile()) {
        fs.copyFileSync(authSource, path.join(staging, "auth.json"));
        fs.chmodSync(path.join(staging, "auth.json"), 0o600);
      }
    }

    // Atomic replace of prior mutable home — never reuse ambient entries.
    fs.rmSync(capsule.codexHome, { recursive: true, force: true });
    fs.renameSync(staging, capsule.codexHome);
    cleanAbandonedCodexStaging(parentDir, null);

    const next = argv.includes("--strict-config")
      ? [...argv] : [...argv, "--strict-config"];
    const checksum = homeChecksum(capsule.codexHome);
    return {
      argv: next,
      env: { CODEX_HOME: capsule.codexHome },
      files: [
        path.join(capsule.codexHome, "config.toml"),
        ...(fs.existsSync(path.join(capsule.codexHome, "auth.json"))
          ? [path.join(capsule.codexHome, "auth.json")] : []),
      ],
      home_generation: generationId,
      generationId,
      home_checksum: checksum,
    };
  },
};
