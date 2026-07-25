/**
 * Normalize specialist budget: token targets are advisory only.
 * schema-v1 `max_tokens` migrates to advisory tokens.target.
 */
export function normalizeBudget(input = {}) {
  const warnings = [];
  const timeout = input.timeout_seconds ?? null;
  let tokens = input.tokens ?? null;

  if (tokens == null && input.max_tokens != null) {
    tokens = { target: input.max_tokens, enforcement: "advisory" };
    warnings.push("budget.max_tokens is deprecated and treated as advisory");
  }
  if (tokens != null) {
    if (!Number.isInteger(tokens.target) || tokens.target <= 0) {
      throw new Error("budget.tokens.target must be a positive integer");
    }
    if ((tokens.enforcement ?? "advisory") !== "advisory") {
      throw new Error("unsupported token enforcement: only advisory is available");
    }
    tokens = { target: tokens.target, enforcement: "advisory" };
  }
  if (timeout != null && (!Number.isInteger(timeout) || timeout <= 0)) {
    throw new Error("budget.timeout_seconds must be a positive integer");
  }
  return { timeout_seconds: timeout, tokens, warnings };
}
