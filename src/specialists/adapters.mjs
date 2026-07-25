/**
 * Concrete enforcement adapters registered in code.
 * Config booleans (mediated_commands / token_budget_adapter) never enable
 * enforcement — only a registered adapter id can. MVP ships none.
 */
export const COMMAND_MEDIATION_ADAPTERS = Object.freeze({
  // none in MVP
});

export const TOKEN_BUDGET_ADAPTERS = Object.freeze({
  // none in MVP
});

/**
 * Resolve whether command/tool allowlists can be enforced for this CLI.
 * Legacy `mediated_commands: true` is ignored (fail-closed).
 */
export function resolveCommandMediation(sandbox = {}, entry = {}) {
  const adapterId =
    sandbox.command_adapter ??
    entry.command_adapter ??
    sandbox.mediated_commands_adapter ??
    null;
  if (typeof adapterId === "string" && COMMAND_MEDIATION_ADAPTERS[adapterId]) {
    return { enabled: true, adapter: adapterId };
  }
  return { enabled: false, adapter: null };
}

/**
 * Resolve whether hard max_tokens can be enforced for this CLI.
 * Legacy `token_budget_adapter: true` is ignored (fail-closed).
 */
export function resolveTokenBudgetAdapter(sandbox = {}, entry = {}) {
  const adapterId =
    sandbox.token_adapter ??
    entry.token_adapter ??
    (typeof sandbox.token_budget_adapter === "string"
      ? sandbox.token_budget_adapter
      : null) ??
    (typeof entry.token_budget_adapter === "string"
      ? entry.token_budget_adapter
      : null);
  if (typeof adapterId === "string" && TOKEN_BUDGET_ADAPTERS[adapterId]) {
    return { enabled: true, adapter: adapterId };
  }
  return { enabled: false, adapter: null };
}
