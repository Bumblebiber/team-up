/**
 * Concrete enforcement adapters registered in code.
 * Config booleans (mediated_commands) never enable enforcement — only a
 * registered adapter id can. MVP ships none for command mediation.
 * Token budgets are advisory (see specialists/budget.mjs); no hard adapter.
 */
export const COMMAND_MEDIATION_ADAPTERS = Object.freeze({
  // none in MVP — harness adapters land in later tasks
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
