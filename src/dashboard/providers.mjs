import fs from "node:fs";
import { atomicWriteText } from "../json-store.mjs";
import { secretsPath } from "../paths.mjs";
import { lookupKey, openRouterKeyFiles, keyHint, parseEnvFileLine } from "../keys.mjs";

const OPENROUTER_KEY = "OPENROUTER_API_KEY";
const VALIDATE_URL = "https://openrouter.ai/api/v1/key";

const CLASS_B = new Set(["claude", "codex", "cursor"]);
const CLASS_C = new Set(["opencode", "hermes"]);

const LOGIN_COMMANDS = {
  claude: "claude auth",
  codex: "codex login",
  cursor: "NO_OPEN_BROWSER=1 cursor-agent login",
  opencode: "opencode providers",
  hermes: "# configure OPENROUTER_API_KEY in ~/.hermes/.env",
};

export function providerClass(id) {
  if (id === "openrouter") return "A";
  if (CLASS_B.has(id)) return "B";
  if (CLASS_C.has(id)) return "C";
  return null;
}

export function readOpenRouterKey({ env = process.env, roster } = {}) {
  return lookupKey({
    keyName: OPENROUTER_KEY,
    keyFiles: openRouterKeyFiles(env, roster),
    env,
  });
}

export function isOpenRouterWritable({ env = process.env, roster, lookup = readOpenRouterKey } = {}) {
  const hit = lookup({ env, roster });
  if (!hit.key) return true;
  if (hit.source === "env") return false;
  if (hit.source === "file") {
    const target = secretsPath(env);
    return hit.filePath === target;
  }
  return false;
}

function readSecretsLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").split("\n");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

function upsertEnvLine(lines, keyName, value) {
  const out = [];
  let replaced = false;
  for (const line of lines) {
    const parsed = parseEnvFileLine(line);
    if (parsed?.name === keyName) {
      if (!replaced) {
        out.push(`${keyName}=${value}`);
        replaced = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!replaced) out.push(`${keyName}=${value}`);
  return out.filter((l, i, arr) => !(i === arr.length - 1 && l === "")).join("\n") + "\n";
}

function removeEnvLine(lines, keyName) {
  const out = lines.filter((line) => parseEnvFileLine(line)?.name !== keyName);
  const text = out.join("\n");
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

export function writeOpenRouterKey(key, { env = process.env } = {}) {
  const filePath = secretsPath(env);
  const lines = readSecretsLines(filePath);
  const text = upsertEnvLine(lines, OPENROUTER_KEY, key);
  atomicWriteText(filePath, text, { mode: 0o600 });
  return filePath;
}

export function removeOpenRouterKey({ env = process.env } = {}) {
  const filePath = secretsPath(env);
  const lines = readSecretsLines(filePath);
  const text = removeEnvLine(lines, OPENROUTER_KEY);
  if (text.trim() === "") {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return null;
  }
  atomicWriteText(filePath, text, { mode: 0o600 });
  return filePath;
}

export async function validateOpenRouterKey(apiKey, { fetchFn = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  if (!apiKey) return { ok: false, status: 0, error: "no key" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(VALIDATE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: `rejected by OpenRouter (${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `OpenRouter HTTP ${res.status}` };
    }
    let body = {};
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    return {
      ok: true,
      status: res.status,
      label: body.data?.label || body.label || null,
      limit: body.data?.limit ?? body.limit ?? null,
    };
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === "AbortError") {
      return { ok: false, status: 0, error: "could not reach OpenRouter — key not saved" };
    }
    return { ok: false, status: 0, error: "could not reach OpenRouter — key not saved" };
  }
}

export function buildProvidersView({ roster, env = process.env, cliPresent = () => false, lastValidation = {} } = {}) {
  const providers = [];
  const orLookup = readOpenRouterKey({ env, roster });
  const orWritable = isOpenRouterWritable({ env, roster });
  const orMeta = lastValidation.openrouter || {};
  providers.push({
    id: "openrouter",
    class: "A",
    configured: !!orLookup.key,
    hint: orLookup.key ? keyHint(orLookup.key) : null,
    source: orLookup.source,
    writable: orWritable,
    last_validated_at: orMeta.at || null,
    last_verdict: orMeta.verdict || null,
    label: orMeta.label || null,
    limit: orMeta.limit ?? null,
  });

  for (const id of Object.keys(roster?.clis || {}).sort()) {
    const cls = providerClass(id);
    if (!cls || cls === "A") continue;
    const present = cliPresent(id);
    providers.push({
      id,
      class: cls,
      configured: present,
      hint: null,
      source: null,
      writable: false,
      login_command: LOGIN_COMMANDS[id] || null,
      last_validated_at: null,
      last_verdict: null,
    });
  }
  return { providers };
}
