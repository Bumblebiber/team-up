// JSON usage collectors for CLIs whose credentials already authorize usage APIs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeWindowRecord } from "./usage-windows.mjs";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 8_000;
const AGY_USAGE_WINDOWS = {
  "gemini-weekly": "weekly",
  "gemini-5h": "5h",
  "3p-weekly": "weekly",
  "3p-5h": "5h",
};

/** Read credential content and mode together so collectors can enforce permissions. */
export function readCredentialFile(filePath) {
  const stat = fs.statSync(filePath);
  const mode = stat.mode & 0o777;
  if (mode & 0o077) return { mode };
  return { content: fs.readFileSync(filePath, "utf8"), mode };
}

function readCredential(filePath, fileReader) {
  let file;
  try {
    file = fileReader(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { error: "credential file missing" };
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      return { error: "credential file unreadable" };
    }
    return { error: "credential file could not be read" };
  }
  if (!file || !Number.isInteger(file.mode)) {
    return { error: "credential file could not be read" };
  }
  if (file.mode & 0o077) return { error: "credential file is group- or world-readable" };
  if (typeof file.content !== "string") return { error: "credential file could not be read" };
  try {
    return { value: JSON.parse(file.content) };
  } catch {
    return { error: "credential file is invalid JSON" };
  }
}

function toNowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "string") return Date.parse(now);
  return now ?? Date.now();
}

function toNowIso(now) {
  return new Date(toNowMs(now)).toISOString();
}

function usageRecord(key, percent, resetAt, source, updatedAt, scope) {
  // Above 100 is an overage reading: clamp it, dropping it would leave the
  // gate on the previous, lower value exactly when the limit is blown.
  if (!Number.isFinite(percent) || percent < 0) return null;
  percent = Math.min(percent, 100);
  const resetMs = typeof resetAt === "number" ? resetAt * 1_000 : Date.parse(resetAt);
  // No usable reset (an idle session can have none): keep the fresh reading
  // with an unknown reset rather than drop it; effectiveResetAt then expires
  // a high reading by the window's staleness ceiling.
  const hasReset = resetAt != null && Number.isFinite(resetMs);
  const record = normalizeWindowRecord(
    key,
    {
      used: percent / 100,
      resets_at: hasReset ? new Date(resetMs).toISOString() : null,
      resets_at_raw: null,
      reset_confidence: hasReset ? "provider" : "unknown",
      updated_at: updatedAt,
      source,
      ...(scope ? { scope } : {}),
    },
    { now: updatedAt }
  );
  if (scope) record.scope = scope;
  return record;
}

function parseClaudeUsage(body, updatedAt) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const windows = {};
  const source = "claude:oauth-usage-api";
  const add = (key, percent, resetAt, scope) => {
    const record = usageRecord(key, percent, resetAt, source, updatedAt, scope);
    if (record) windows[key] = record;
  };

  if (Object.hasOwn(body, "limits")) {
    if (!Array.isArray(body.limits)) return windows;
    for (const entry of body.limits) {
      if (!entry || typeof entry !== "object" || entry.scope?.surface != null) continue;
      if (entry.kind === "session") {
        add("claude:session", entry.percent, entry.resets_at);
      } else if (entry.kind === "weekly_all") {
        add("claude:week", entry.percent, entry.resets_at);
      } else if (entry.kind === "weekly_scoped") {
        const displayName = entry.scope?.model?.display_name;
        if (typeof displayName !== "string" || !displayName.trim()) continue;
        const scope = displayName.trim().toLowerCase().replace(/\s+/g, "-");
        add(`claude:${scope}-week`, entry.percent, entry.resets_at, scope);
      }
    }
    return windows;
  }

  for (const [sourceKey, usageKey] of [["five_hour", "claude:session"], ["seven_day", "claude:week"]]) {
    const window = body[sourceKey];
    if (window && typeof window === "object") add(usageKey, window.utilization, window.resets_at);
  }
  return windows;
}

function codexWindowName(limitWindowSeconds) {
  if (limitWindowSeconds === 18_000) return "5h";
  if (limitWindowSeconds === 604_800) return "weekly";
  return null;
}

function parseCodexRateLimit(rateLimit, updatedAt, source, prefix, scope = null) {
  const windows = {};
  for (const window of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    if (!window || typeof window !== "object") continue;
    const windowName = codexWindowName(window.limit_window_seconds);
    if (!windowName) continue;
    const key = `${prefix}${windowName}`;
    const record = usageRecord(key, window.used_percent, window.reset_at, source, updatedAt, scope);
    if (record) windows[key] = record;
  }
  return windows;
}

function parseCodexUsage(body, updatedAt) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const windows = parseCodexRateLimit(body.rate_limit, updatedAt, "codex:wham-usage-api", "codex:");
  for (const additional of body.additional_rate_limits || []) {
    if (!additional || typeof additional !== "object") continue;
    const modelSlug = additional.normal_model_slug;
    const limitName = additional.limit_name;
    if (typeof modelSlug !== "string" || !modelSlug || typeof limitName !== "string" || !limitName) continue;
    const modelSuffix = modelSlug.split("/").at(-1).split("-").at(-1);
    const limitSuffix = limitName.replace(/^gpt-/, "");
    Object.assign(
      windows,
      parseCodexRateLimit(
        additional.rate_limit,
        updatedAt,
        "codex:wham-usage-api",
        `codex:${modelSuffix}-${limitSuffix}-`,
        modelSlug
      )
    );
  }
  return windows;
}

/** Map agy's `/usage` command buckets into the four quota windows team-up gates. */
export function parseAgyUsage(body, updatedAt = toNowIso(Date.now())) {
  const buckets = body?.command?.data?.groups;
  if (!Array.isArray(buckets)) return {};
  const windows = {};
  for (const group of buckets) {
    if (!Array.isArray(group?.buckets)) continue;
    for (const bucket of group.buckets) {
      if (!bucket || typeof bucket.id !== "string") continue;
      const expectedWindow = AGY_USAGE_WINDOWS[bucket.id];
      if (!expectedWindow || bucket.window !== expectedWindow) continue;
      if (typeof bucket.remaining_fraction !== "number" ||
        !Number.isFinite(bucket.remaining_fraction) ||
        bucket.remaining_fraction < 0 || bucket.remaining_fraction > 1) continue;
      const key = `agy:${bucket.id}`;
      const record = usageRecord(
        key,
        (1 - bucket.remaining_fraction) * 100,
        bucket.reset_time,
        "agy:usage-command",
        updatedAt,
      );
      if (record) windows[key] = record;
    }
  }
  return windows;
}

/** Run agy's zero-token `/usage` print command and require all quota buckets. */
export function fetchAgyUsageJson({
  run = execFileSync,
  env = process.env,
  now = Date.now(),
} = {}) {
  let stdout;
  try {
    stdout = run("agy", ["-p", "/usage", "--output-format", "json"], {
      encoding: "utf8",
      env,
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "").trim();
    return { ok: false, reason: detail ? `agy /usage command failed: ${detail.slice(-300)}` : "agy /usage command failed" };
  }
  let body;
  try {
    body = JSON.parse(String(stdout || ""));
  } catch {
    return { ok: false, reason: "agy /usage returned invalid JSON" };
  }
  const windows = parseAgyUsage(body, toNowIso(now));
  const required = Object.keys(AGY_USAGE_WINDOWS).map((id) => `agy:${id}`);
  const missing = required.filter((key) => !windows[key]);
  if (missing.length) return { ok: false, reason: `agy /usage response lacked ${missing.join(", ")}` };
  return { ok: true, windows };
}

function requestFailure(error) {
  if (error?.name === "TimeoutError" || error?.code === "ETIMEDOUT" || error?.code === "UND_ERR_CONNECT_TIMEOUT") {
    return "usage API request timed out";
  }
  return "usage API request failed";
}

async function readResponse(response) {
  if (!response || response.status !== 200) {
    return { error: `usage API returned HTTP ${Number.isInteger(response?.status) ? response.status : "unknown"}` };
  }
  try {
    return { body: await response.json() };
  } catch {
    return { error: "usage API returned invalid JSON" };
  }
}

/** Read Claude's OAuth usage with its existing access token. Token never leaves this function. */
export async function fetchClaudeUsageJson({
  env = process.env,
  homeDir = os.homedir(),
  fileReader = readCredentialFile,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(homeDir, ".claude");
  const credential = readCredential(path.join(configDir, ".credentials.json"), fileReader);
  if (credential.error) return { ok: false, reason: credential.error };
  const oauth = credential.value?.claudeAiOauth;
  const accessToken = oauth?.accessToken;
  if (typeof accessToken !== "string" || !accessToken) {
    return { ok: false, reason: "Claude OAuth access token missing" };
  }
  if (!Number.isFinite(oauth?.expiresAt)) return { ok: false, reason: "Claude OAuth token expiry missing" };
  if (oauth.expiresAt <= toNowMs(now)) return { ok: false, reason: "Claude OAuth token expired" };

  let response;
  try {
    response = await fetchImpl(CLAUDE_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
        "User-Agent": "claude-code/2.1.0",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: requestFailure(error) };
  }
  const responseData = await readResponse(response);
  if (responseData.error) return { ok: false, reason: responseData.error };
  const updatedAt = toNowIso(now);
  let windows;
  try {
    windows = parseClaudeUsage(responseData.body, updatedAt);
  } catch {
    return { ok: false, reason: "usage API returned an invalid response" };
  }
  // Both base windows or the PTY path: a dropped one would leave the gate on
  // its previous value. A reading without a reset is kept, so an idle session
  // does not trip this.
  if (!windows["claude:session"] || !windows["claude:week"]) {
    return { ok: false, reason: "usage API response lacked the session or week window" };
  }
  return { ok: true, windows };
}

/** Read Codex's WHAM usage with its existing access token. Token never leaves this function. */
export async function fetchCodexUsageJson({
  env = process.env,
  homeDir = os.homedir(),
  fileReader = readCredentialFile,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  const codexHome = env.CODEX_HOME || path.join(homeDir, ".codex");
  const credential = readCredential(path.join(codexHome, "auth.json"), fileReader);
  if (credential.error) return { ok: false, reason: credential.error };
  const tokens = credential.value?.tokens;
  const accessToken = tokens?.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    return { ok: false, reason: "Codex access token missing" };
  }

  let response;
  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "codex-cli",
    };
    if (typeof tokens.account_id === "string" && tokens.account_id) {
      headers["ChatGPT-Account-ID"] = tokens.account_id;
    }
    response = await fetchImpl(CODEX_USAGE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: requestFailure(error) };
  }
  const responseData = await readResponse(response);
  if (responseData.error) return { ok: false, reason: responseData.error };
  const updatedAt = toNowIso(now);
  let windows;
  try {
    windows = parseCodexUsage(responseData.body, updatedAt);
  } catch {
    return { ok: false, reason: "usage API returned an invalid response" };
  }
  if (!windows["codex:5h"] || !windows["codex:weekly"]) {
    return { ok: false, reason: "usage API response lacked the 5h or weekly window" };
  }
  return { ok: true, windows };
}
