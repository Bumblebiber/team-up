/**
 * Pure result carrier for isolation canary guards.
 * Failure: { ok: false, reason: stable_code, detail?: safe_string }
 * Success: the value directly (no wrapper) — keeps grant payloads unchanged.
 */

export function isoFail(reason, detail) {
  return {
    ok: false,
    reason,
    ...(detail != null && detail !== "" ? { detail: String(detail) } : {}),
  };
}

export function isIsoFailure(result) {
  return result != null && typeof result === "object" && result.ok === false;
}

export function isoValue(result) {
  return isIsoFailure(result) ? null : result;
}

export function formatIsoFailure(result) {
  if (!isIsoFailure(result)) return null;
  const detail = result.detail ? `: ${result.detail}` : "";
  return `${result.reason}${detail}`;
}

/** First failure in a chain; pass through success values unchanged. */
export function firstIsoFailure(...results) {
  for (const r of results) {
    if (isIsoFailure(r)) return r;
  }
  return null;
}

export function capabilityReasonFromFailure(result) {
  if (!isIsoFailure(result)) return null;
  return {
    code: result.reason,
    ...(result.detail ? { detail: result.detail } : {}),
  };
}
