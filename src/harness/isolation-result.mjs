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

/** Cap safe diagnostic detail length (matches cli-verify isolation_error truncation). */
export function truncateIsoDetail(text, max = 500) {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(0, max);
}

export function formatIsoFailure(result) {
  if (!isIsoFailure(result)) return null;
  const detail = result.detail ? `: ${result.detail}` : "";
  return `${result.reason}${detail}`;
}

export function capabilityReasonFromFailure(result) {
  if (!isIsoFailure(result)) return null;
  return {
    code: result.reason,
    ...(result.detail ? { detail: result.detail } : {}),
  };
}
