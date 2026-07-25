import { modelUsageGate, parseResetAt, windowIsBlocking } from "../usage/usage-windows.mjs";

function toMs(now) {
  return typeof now === "string" ? Date.parse(now) : now;
}

function windowResetMs(w, nowMs) {
  if (!w) return null;
  if (w.resets_at && /^\d{4}-\d{2}-\d{2}T/.test(String(w.resets_at))) {
    const ms = Date.parse(w.resets_at);
    return Number.isFinite(ms) ? ms : null;
  }
  return parseResetAt(w.resets_at_raw || w.resets_at, nowMs);
}

/**
 * Availability for one exact-tier candidate cell.
 * Blocking windows' latest known reset becomes available_at.
 */
export function candidateAvailability({ candidate, usage, roster, now = Date.now() }) {
  const nowMs = toMs(now);
  const model = roster?.models?.[candidate.model] || {};
  const limitWindows = Array.isArray(model.limit_windows) ? model.limit_windows : [];
  const limits = roster?.limits || {};
  const gate = modelUsageGate({
    usage,
    limitWindows,
    provider: model.provider,
    cli: candidate.cli,
    limits,
    now: nowMs,
  });

  if (!gate.blocked) {
    return {
      candidate,
      available: true,
      available_at: null,
      blocking_windows: [],
      reset_confidence: "provider",
    };
  }

  const blocking = [];
  let latestResetMs = null;
  let unknown = false;
  for (const wkey of limitWindows) {
    if (!windowIsBlocking(wkey, usage, limits, nowMs)) continue;
    blocking.push(wkey);
    const w = usage?.windows?.[wkey];
    const ms = windowResetMs(w, nowMs);
    if (ms == null) unknown = true;
    else if (latestResetMs == null || ms > latestResetMs) latestResetMs = ms;
  }

  return {
    candidate,
    available: false,
    available_at: unknown || latestResetMs == null ? null : new Date(latestResetMs).toISOString(),
    blocking_windows: blocking.length ? blocking : [gate.reason],
    reset_confidence: unknown ? "unknown" : "provider",
  };
}

export function chainCapacityReport({ profileResult, usage, roster, now = Date.now() }) {
  const reports = (profileResult?.chain || []).map((candidate) =>
    candidateAvailability({ candidate, usage, roster, now })
  );
  const available = reports.filter((r) => r.available);
  const blocked = reports.filter((r) => !r.available);
  let nextResetAt = null;
  let resetConfidence = "provider";
  if (!available.length) {
    for (const r of blocked) {
      if (r.available_at == null) {
        resetConfidence = "unknown";
        continue;
      }
      if (nextResetAt == null || Date.parse(r.available_at) < Date.parse(nextResetAt)) {
        nextResetAt = r.available_at;
      }
    }
  }
  return {
    available_count: available.length,
    blocked_candidates: blocked,
    next_reset_at: available.length ? null : nextResetAt,
    reset_confidence: available.length ? "provider" : resetConfidence,
    reports,
  };
}
