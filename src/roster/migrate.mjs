import { normalizeTier } from "./profile.mjs";

const DEFAULT_REASONING = {
  claude: { max: "max", high: "high", medium: "medium", low: "low" },
  codex: { max: "xhigh", high: "high", medium: "medium", low: "low" },
  cursor: { max: "high", high: "high", medium: null, low: null },
  hermes: { max: "high", high: "high", medium: "medium", low: "low" },
  opencode: { max: "high", high: "high", medium: "medium", low: "low" },
};

const PROVIDER_ACCOUNT = {
  anthropic: "claude",
  openai: "codex",
  cursor: "cursor",
  xai: "cursor",
  deepseek: "api",
};

function defaultAccountForModel(model) {
  if (PROVIDER_ACCOUNT[model.provider]) return PROVIDER_ACCOUNT[model.provider];
  const cli0 = model.cli?.[0];
  if (cli0 === "claude") return "claude";
  if (cli0 === "codex") return "codex";
  if (cli0 === "cursor") return "cursor";
  return "api";
}

function defaultReasoningForModel(model) {
  const cli0 = model.cli?.[0];
  return { ...(DEFAULT_REASONING[cli0] || DEFAULT_REASONING.cursor) };
}

function ensureClaudeEffortSlot(roster) {
  const cmd = roster.clis?.claude?.cmd;
  if (!Array.isArray(cmd) || cmd.some((arg) => arg.includes("{effort}"))) return;
  const promptIndex = cmd.indexOf("{prompt}");
  if (promptIndex === -1) return;
  cmd.splice(promptIndex, 0, "--effort", "{effort}");
}

/**
 * Deterministic migration of legacy o9k/team-up roster shapes:
 * - mid → medium
 * - ensure accounts exist for subscriptions/providers
 * - ensure every tiered (specialist-eligible) model has account + reasoning map
 * - add Claude's native effort slot to legacy command templates
 */
export function migrateRoster(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("roster must be an object");
  }
  const roster = structuredClone(input);
  delete roster.$comment;

  if (!roster.accounts || typeof roster.accounts !== "object") {
    roster.accounts = {};
  }

  const ensureSub = (id) => {
    if (!roster.accounts[id]) {
      roster.accounts[id] = { kind: "subscription", enabled: true };
    }
  };
  const ensureCredit = (id) => {
    if (!roster.accounts[id]) {
      roster.accounts[id] = { kind: "credit", enabled: true, remaining: 1 };
    }
  };

  for (const sub of roster.subscriptions || []) {
    ensureSub(sub);
  }
  ensureSub("claude");
  ensureSub("codex");
  ensureSub("cursor");
  ensureCredit("api");

  if (roster.models && typeof roster.models === "object") {
    for (const [, model] of Object.entries(roster.models)) {
      if (!model || typeof model !== "object") continue;
      if (model.tier != null) {
        try {
          model.tier = normalizeTier(model.tier);
        } catch {
          // leave invalid for validator
        }
      }
      if (model.tier != null) {
        if (!model.account) model.account = defaultAccountForModel(model);
        if (!model.reasoning || typeof model.reasoning !== "object") {
          model.reasoning = defaultReasoningForModel(model);
        }
      }
    }
  }

  roster.schema_version = roster.schema_version || 2;
  ensureClaudeEffortSlot(roster);
  return roster;
}
