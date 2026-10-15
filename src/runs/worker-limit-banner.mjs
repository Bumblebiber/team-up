// worker-limit-banner.mjs — detect provider quota banners at the pane tail (Paperclip-classified).

import { stripAnsi } from "../collectors/strip-ansi.mjs";
import { parseResetAt } from "../usage/usage-windows.mjs";

function normalizePaneText(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

/** Last lines scanned — workers editing team-up embed limit strings in source above. */
export const BANNER_TAIL_LINES = 25;

const DEFAULT_LIMIT_TTL_MS = 5 * 3_600_000;

// paperclip packages/adapters/claude-local/src/server/parse.ts
const CLAUDE_LOGIN_PROMPT_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+(?:`?claude\s+login`?|\/login)|login\s+required|requires\s+login|unauthorized|authentication\s+required|invalid\s+api\s+key[\s\S]{0,120}(?:\/login|claude\s+login|log\s+in))/i;

export const CLAUDE_PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+(?:\w+\s+)?limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached|servicequotaexceededexception)/i;

const CLAUDE_EXTRA_USAGE_RESET_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+(?:\w+\s+)?limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage|usage\s+limit\s+reached|usage\s+cap\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|claude\s+usage\s+limit\s+reached)[\s\S]{0,120}?\bresets?\s+(?:at\s+)?([^\n()]+?)(?:\s*\(([^)]+)\))?(?:[.!]|\n|$)/i;

const CLAUDE_TRY_AGAIN_RESET_RE =
  /(?:try again at|resets?(?:\s+at)?)\s+(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?/i;

const CLAUDE_MAX_TURNS_RE =
  /(?:error_max_turns|max\s+turns|max_turns|turn_limit(?:\s+exhausted)?)/i;

const CLAUDE_UNKNOWN_SESSION_RE =
  /no conversation found with session id|unknown session|session .* not found|not a valid UUID|--resume requires a valid session|is not a UUID|does not match any session title/i;

// paperclip packages/adapters/codex-local/src/server/parse.ts
const CODEX_USAGE_LIMIT_RE =
  /you(?:'|’)ve hit your usage limit for .+\.\s+switch to another model now,\s+or try again at\s+([^.!\n]+)(?:[.!]|\n|$)/i;

const CODEX_PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve hit your usage limit|usage limit|model (?:is )?at capacity|at capacity for this model|capacity limit)/i;

const CODEX_HIT_LIMIT_RESET_RE = /hit your usage limit.*?try again at\s+([^.]+)/is;

export function paneBannerTail(pane, maxLines = BANNER_TAIL_LINES) {
  const lines = stripAnsi(normalizePaneText(pane)).split("\n");
  return lines.slice(-maxLines).join("\n");
}

function paneBannerTailLines(pane, maxLines = BANNER_TAIL_LINES) {
  return stripAnsi(normalizePaneText(pane)).split("\n").slice(-maxLines);
}

/** Quota banners are their own pane lines — not // comments or source scrollback. */
function bannerQuotaHaystack(pane) {
  const lines = [];
  for (const line of paneBannerTailLines(pane)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:\/\/|#|\*|const |let |var |export |import |function )/.test(trimmed)) continue;
    lines.push(trimmed);
  }
  return lines.join("\n");
}

function claudeWindowKey(haystack) {
  if (/5[-\s]?hour\s+limit/i.test(haystack)) return "claude:5h";
  if (/weekly\s+limit/i.test(haystack)) return "claude:week";
  if (/session\s+limit/i.test(haystack)) return "claude:session";
  return "claude:5h";
}

function codexWindowKey(haystack) {
  if (/\b5h\b|5[-\s]?hour/i.test(haystack)) return "codex:5h";
  if (/weekly/i.test(haystack)) return "codex:weekly";
  return "codex:weekly";
}

function extractClaudeResetRaw(haystack) {
  const extra = CLAUDE_EXTRA_USAGE_RESET_RE.exec(haystack);
  if (extra) {
    const clock = (extra[1] || "").trim();
    const zone = (extra[2] || "").trim();
    if (zone) return `${clock} (${zone})`;
    return clock;
  }
  const tryAgain = CLAUDE_TRY_AGAIN_RESET_RE.exec(haystack);
  if (!tryAgain) return null;
  const hour = tryAgain[1];
  const min = tryAgain[2] ? `:${tryAgain[2]}` : "";
  const ampm = tryAgain[3] ? `${tryAgain[3]}m` : "";
  const zone = tryAgain[4] || tryAgain[5] || "";
  const clock = `${hour}${min}${ampm}`.trim();
  return zone ? `${clock} (${zone})` : clock;
}

function extractCodexResetRaw(haystack) {
  const strict = CODEX_USAGE_LIMIT_RE.exec(haystack);
  if (strict) return (strict[1] || "").trim();
  const loose = CODEX_HIT_LIMIT_RESET_RE.exec(haystack);
  if (loose) return (loose[1] || "").trim();
  return null;
}

function claudeQuotaExcluded(haystack) {
  if (CLAUDE_LOGIN_PROMPT_RE.test(haystack)) return true;
  if (CLAUDE_MAX_TURNS_RE.test(haystack)) return true;
  if (CLAUDE_UNKNOWN_SESSION_RE.test(haystack)) return true;
  return false;
}

/**
 * @param {string} pane
 * @param {"claude"|"codex"|string} cli
 * @param {number} [now]
 * @returns {{ windowKey: string, resetRaw: string|null, ttlMs: number }|null}
 */
export function detectWorkerLimitBanner(pane, cli, now = Date.now()) {
  if (cli !== "claude" && cli !== "codex") return null;
  const haystack = bannerQuotaHaystack(pane);
  if (!haystack.trim()) return null;

  if (cli === "claude") {
    if (claudeQuotaExcluded(haystack)) return null;
    if (!CLAUDE_PROVIDER_QUOTA_RE.test(haystack)) return null;
    const resetRaw = extractClaudeResetRaw(haystack);
    return {
      windowKey: claudeWindowKey(haystack),
      resetRaw,
      ttlMs: limitTtlMs(resetRaw, now),
    };
  }

  if (!CODEX_PROVIDER_QUOTA_RE.test(haystack) && !CODEX_HIT_LIMIT_RESET_RE.test(haystack)) return null;
  const resetRaw = extractCodexResetRaw(haystack);
  return {
    windowKey: codexWindowKey(haystack),
    resetRaw,
    ttlMs: limitTtlMs(resetRaw, now),
  };
}

export function limitTtlMs(resetRaw, now = Date.now()) {
  if (resetRaw) {
    const resetMs = parseResetAt(resetRaw, now);
    if (Number.isFinite(resetMs) && resetMs > now) return resetMs - now;
  }
  return DEFAULT_LIMIT_TTL_MS;
}
