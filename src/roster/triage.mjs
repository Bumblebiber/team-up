import { normalizeTier, resolveProfile } from "./profile.mjs";
import { evaluatePickCell } from "./chain.mjs";
import { lookupKey, openRouterKeyFiles } from "../keys.mjs";
import { secretsPath } from "../paths.mjs";

const TIER_LEVELS = ["low", "medium", "high", "frontier"];
const REASONING_LEVELS = ["low", "medium", "high", "max"];

const TIER_CRITERIA = [
  "Small, isolated task with clear steps and low risk; a small model can finish it.",
  "Moderate task across a few files using familiar patterns and clear acceptance criteria.",
  "Complex implementation or debugging across interacting modules with significant tradeoffs.",
  "Novel, ambiguous, or high-risk system work requiring the strongest available model.",
];
const REASONING_CRITERIA = [
  "Direct execution with little planning or analysis needed.",
  "Several familiar steps or modest tradeoffs require some reasoning.",
  "Subtle failure modes or many interacting components require deep reasoning.",
  "Exceptional reasoning is needed for novel architecture or unusually difficult correctness problems.",
];

const DEFAULT_TRIAGE = {
  endpoint: "https://openrouter.ai/api/alpha/decisions",
  key_env: "OPENROUTER_API_KEY",
  model: "jev-latest",
  timeout_ms: 1500,
  min_confidence: 0.6,
  mode: "shadow",
  active_share: 0,
  roles: ["implementer", "researcher", "test-writer"],
};

function triageConfig(roster) {
  return { ...DEFAULT_TRIAGE, ...(roster?.triage || {}) };
}

export function isTriageEnabled(roster) {
  return roster?.triage?.enabled === true;
}

export function isRoleTriagable(roster, role) {
  const cfg = triageConfig(roster);
  return !role || cfg.roles.includes(role);
}

/**
 * Whether dispatch should run triage for this spawn.
 * `--triage` is accepted as a no-op when auto-triage would already run.
 */
export function shouldRunTriage({ roster, role, modelPin, noTriage = false }) {
  if (noTriage) return false;
  if (modelPin) return false;
  if (!isTriageEnabled(roster)) return false;
  if (!isRoleTriagable(roster, role)) return false;
  return true;
}

/**
 * Resolve triage API key without mutating process.env.
 * Env wins over secrets.env, then triage.key_file.
 */
export function lookupTriageKey({ roster, env = process.env, warn = (msg) => console.error(msg) }) {
  const cfg = triageConfig(roster);
  const keyName = cfg.key_env || DEFAULT_TRIAGE.key_env;
  const keyFiles = [secretsPath(env)];
  if (cfg.key_file) keyFiles.push(cfg.key_file);
  return lookupKey({ keyName, keyFiles, env, warn });
}

export function shouldUseActiveTriage(roster, random = Math.random) {
  const share = triageConfig(roster).active_share ?? 0;
  if (share <= 0) return false;
  if (share >= 1) return true;
  return random() < share;
}

export function bumpTier(tier) {
  const t = normalizeTier(tier);
  const idx = TIER_LEVELS.indexOf(t);
  if (idx === -1 || idx >= TIER_LEVELS.length - 1) return t;
  return TIER_LEVELS[idx + 1];
}

export function bumpReasoning(reasoning) {
  const idx = REASONING_LEVELS.indexOf(reasoning);
  if (idx === -1 || idx >= REASONING_LEVELS.length - 1) return reasoning;
  return REASONING_LEVELS[idx + 1];
}

function fallbackOutput(fallback_reason, latency_ms = 0) {
  return {
    source: "fallback",
    profile: null,
    confidence: { tier: 0, reasoning: 0 },
    fallback_reason,
    latency_ms,
  };
}

function truncatePrompt(prompt, maxChars = 112_000) {
  const text = String(prompt || "");
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
}

function buildState({ prompt, role, roster }) {
  const roleSpec = role ? roster?.roles?.[role] : null;
  return {
    prompt: truncatePrompt(prompt),
    role: role || null,
    ...(roleSpec?.description ? { role_description: roleSpec.description } : {}),
  };
}

function scoreAtLevel(answer, criteria) {
  if (!answer || answer.type !== "score") return null;
  const score = answer.score;
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (score < 0 || score > criteria.length - 1) return null;
  // Score is a probability-weighted position and may fall between levels.
  const idx = Math.round(score);
  return { index: idx, confidence: answer.confidence ?? 0 };
}

export function applyLowConfidenceRoundUp(profile, confidence, minConfidence) {
  let tier = profile.tier;
  let reasoning = profile.reasoning;
  let lowConfidence = false;

  if ((confidence.tier ?? 0) < minConfidence) {
    tier = bumpTier(tier);
    lowConfidence = true;
  }
  if ((confidence.reasoning ?? 0) < minConfidence) {
    reasoning = bumpReasoning(reasoning);
    lowConfidence = true;
  }

  return {
    profile: { tier, reasoning },
    lowConfidence,
  };
}

/**
 * Resolve a triage profile into a spawn cell, bumping tier once on failure.
 * Returns { useRoleChain, cell } where cell is evaluatePickCell output.
 */
export function resolveTriageDispatch({
  roster,
  usage,
  triageOutput,
  role,
  now = Date.now(),
}) {
  if (!triageOutput?.profile) {
    return { useRoleChain: true, cell: null };
  }

  let profile = { ...triageOutput.profile };
  for (let attempt = 0; attempt < 2; attempt++) {
    const resolved = resolveProfile({ roster, usage, profile, now });
    if (resolved.code === "OK" && resolved.chain.length) {
      const top = resolved.chain[0];
      const cell = evaluatePickCell({
        roster,
        usage,
        role,
        model: top.model,
        cli: top.cli,
        entryEffort: top.effort,
        now,
      });
      if (cell.model) {
        return { useRoleChain: false, cell, profile };
      }
    }
    const bumped = bumpTier(profile.tier);
    if (bumped === profile.tier) break;
    profile = { ...profile, tier: bumped };
  }
  return { useRoleChain: true, cell: null };
}

export async function triage({
  roster,
  prompt,
  role,
  env = {},
  fetch: fetchFn = globalThis.fetch,
  now = Date.now(),
  random = Math.random,
}) {
  const started = now;
  const cfg = triageConfig(roster);

  if (!isTriageEnabled(roster)) {
    return fallbackOutput("disabled", 0);
  }
  if (role && !isRoleTriagable(roster, role)) {
    return fallbackOutput("role_not_allowlisted", 0);
  }

  const { key: apiKey } = lookupTriageKey({ roster, env });
  if (!apiKey) {
    return fallbackOutput("no_key", 0);
  }

  const body = {
    model: cfg.model || DEFAULT_TRIAGE.model,
    state: buildState({ prompt, role, roster }),
    questions: {
      tier: {
        type: "score",
        instructions: "What compute tier fits this task?",
        criteria: TIER_CRITERIA,
      },
      reasoning: {
        type: "score",
        instructions: "What reasoning depth fits this task?",
        criteria: REASONING_CRITERIA,
      },
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeout_ms ?? DEFAULT_TRIAGE.timeout_ms);

  let response;
  try {
    response = await fetchFn(cfg.endpoint || DEFAULT_TRIAGE.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    if (error?.name === "AbortError") {
      return fallbackOutput("timeout", latency_ms);
    }
    return fallbackOutput("http_5xx", latency_ms);
  }
  clearTimeout(timeout);

  const latency_ms = Date.now() - started;

  if (response.status >= 500) {
    return fallbackOutput("http_5xx", latency_ms);
  }
  if (response.status >= 400) {
    return fallbackOutput("http_4xx", latency_ms);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return fallbackOutput("invalid_answer", latency_ms);
  }

  const tierHit = scoreAtLevel(payload?.answers?.tier, TIER_CRITERIA);
  const reasoningHit = scoreAtLevel(payload?.answers?.reasoning, REASONING_CRITERIA);
  if (!tierHit || !reasoningHit) {
    return fallbackOutput("invalid_answer", latency_ms);
  }

  let tier;
  try {
    tier = normalizeTier(TIER_LEVELS[tierHit.index]);
  } catch {
    return fallbackOutput("invalid_answer", latency_ms);
  }

  const confidence = { tier: tierHit.confidence, reasoning: reasoningHit.confidence };
  const minConfidence = cfg.min_confidence ?? DEFAULT_TRIAGE.min_confidence;

  const { profile, lowConfidence } = applyLowConfidenceRoundUp(
    { tier, reasoning: REASONING_LEVELS[reasoningHit.index] },
    confidence,
    minConfidence,
  );

  return {
    source: "jev",
    profile,
    confidence,
    fallback_reason: lowConfidence ? "low_confidence" : null,
    latency_ms,
  };
}

export { DEFAULT_TRIAGE, TIER_CRITERIA, REASONING_CRITERIA };
