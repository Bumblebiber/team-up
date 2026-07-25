/**
 * Concrete enforcement adapters registered in code.
 * Config booleans (mediated_commands) never enable enforcement.
 * Verified harness command_broker capability enables mediation.
 * Token budgets are advisory (see specialists/budget.mjs).
 */
import { COMMAND_BROKER_CAPABILITY } from "../harness/capabilities.mjs";

export const COMMAND_MEDIATION_ADAPTERS = Object.freeze({
  [COMMAND_BROKER_CAPABILITY]: true,
});

/**
 * Resolve whether command/tool allowlists can be enforced for this CLI.
 * Legacy `mediated_commands: true` is ignored (fail-closed).
 * A verified harness capability record is authoritative.
 */
export function resolveCommandMediation(sandbox = {}, entry = {}, { harnessCapabilities } = {}) {
  if (harnessCapabilities?.command_broker === COMMAND_BROKER_CAPABILITY) {
    return { enabled: true, adapter: COMMAND_BROKER_CAPABILITY };
  }
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
