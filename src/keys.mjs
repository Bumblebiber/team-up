import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { secretsPath } from "./paths.mjs";

export function parseEnvFileLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;
  const name = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { name, value };
}

function expandHome(filePath) {
  if (!filePath || typeof filePath !== "string") return filePath;
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  if (filePath === "~") return os.homedir();
  return filePath;
}

/**
 * Resolve an API key without mutating process.env.
 * Env wins over key files. Refuses group/world-readable key files.
 */
export function lookupKey({
  keyName,
  keyFiles = [],
  env = {},
  warn = (msg) => console.error(msg),
} = {}) {
  const fromEnv = env[keyName];
  if (fromEnv) return { key: fromEnv, source: "env", filePath: null };

  for (const keyFile of keyFiles) {
    if (!keyFile) continue;
    const resolved = expandHome(keyFile);
    try {
      const stat = fs.statSync(resolved);
      const mode = stat.mode & 0o777;
      if (mode & 0o077) {
        warn(`keys: key file ${resolved} is group- or world-readable; refusing`);
        continue;
      }
      const content = fs.readFileSync(resolved, "utf8");
      for (const line of content.split("\n")) {
        const parsed = parseEnvFileLine(line);
        if (parsed?.name === keyName) {
          return { key: parsed.value, source: "file", filePath: resolved };
        }
      }
    } catch {
      /* try next file */
    }
  }
  return { key: null, source: null, filePath: null };
}

/** Key file list for OpenRouter: team-up secrets first, then roster triage key_file. */
export function openRouterKeyFiles(env = process.env, roster) {
  const files = [secretsPath(env)];
  const keyFile = roster?.triage?.key_file;
  if (keyFile) files.push(keyFile);
  return files;
}

export function keyHint(key) {
  if (!key || typeof key !== "string" || key.length < 4) return null;
  return `…${key.slice(-4)}`;
}
