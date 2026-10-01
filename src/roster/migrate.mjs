function ensureClaudeEffortSlot(roster) {
  const cmd = roster.clis?.claude?.cmd;
  if (!Array.isArray(cmd) || cmd.some((arg) => arg.includes("{effort}"))) return;
  const promptIndex = cmd.indexOf("{prompt}");
  if (promptIndex === -1) return;
  cmd.splice(promptIndex, 0, "--effort", "{effort}");
}

/**
 * Deterministic migration of legacy o9k/team-up roster shapes:
 * - ensure accounts exist for subscriptions/providers
 * - drop model tiers, specialist tier profiles and the triage block (roles
 *   replaced tiers); triage's OpenRouter key_file moves to openrouter.key_file
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

  for (const model of Object.values(roster.models || {})) {
    if (model && typeof model === "object") delete model.tier;
  }
  if (roster.triage && typeof roster.triage === "object") {
    if (roster.triage.key_file && !roster.openrouter?.key_file) {
      roster.openrouter = { ...(roster.openrouter || {}), key_file: roster.triage.key_file };
    }
    delete roster.triage;
  }
  for (const [id, spec] of Object.entries(roster.specialists || {})) {
    if (!spec || typeof spec !== "object") continue;
    delete spec.model_profile;
    if (!Object.keys(spec).length) delete roster.specialists[id];
  }
  if (roster.specialists && !Object.keys(roster.specialists).length) delete roster.specialists;

  roster.schema_version = roster.schema_version || 2;
  ensureClaudeEffortSlot(roster);
  return roster;
}
