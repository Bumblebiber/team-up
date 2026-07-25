import { modelUsageGate, parseResetAt, windowIsBlocking } from "../usage/usage-windows.mjs";

const CONFIDENCE_RANK = {
  provider: 4,
  parsed: 3,
  estimated: 2,
  unknown: 1,
};

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

function normalizeConfidence(value) {
  if (value === "provider" || value === "parsed" || value === "estimated" || value === "unknown") {
    return value;
  }
  return "unknown";
}

function weakerConfidence(a, b) {
  const ra = CONFIDENCE_RANK[normalizeConfidence(a)] || 0;
  const rb = CONFIDENCE_RANK[normalizeConfidence(b)] || 0;
  return ra <= rb ? normalizeConfidence(a) : normalizeConfidence(b);
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
  let confidence = "provider";
  let unknown = false;
  for (const wkey of limitWindows) {
    if (!windowIsBlocking(wkey, usage, limits, nowMs)) continue;
    blocking.push(wkey);
    const w = usage?.windows?.[wkey];
    const ms = windowResetMs(w, nowMs);
    const wConf = normalizeConfidence(w?.reset_confidence ?? (ms != null ? "provider" : "unknown"));
    confidence = weakerConfidence(confidence, wConf);
    if (ms == null) unknown = true;
    else if (latestResetMs == null || ms > latestResetMs) latestResetMs = ms;
  }

  if (unknown) confidence = weakerConfidence(confidence, "unknown");

  return {
    candidate,
    available: false,
    available_at: unknown || latestResetMs == null ? null : new Date(latestResetMs).toISOString(),
    blocking_windows: blocking.length ? blocking : [gate.reason],
    reset_confidence: confidence,
  };
}

export function chainCapacityReport({ profileResult, usage, roster, now = Date.now() }) {
  const chain = profileResult?.chain || [];
  const quotaBlocked = profileResult?.quota_blocked || [];
  // Include exact-tier capability-compatible quota-blocked cells so an
  // exhausted chain still reports reset information.
  const seen = new Set();
  const candidates = [];
  for (const c of [...chain, ...quotaBlocked]) {
    const key = `${c.cli}:${c.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(c);
  }

  const reports = candidates.map((candidate) =>
    candidateAvailability({ candidate, usage, roster, now })
  );
  const available = reports.filter((r) => r.available);
  const blocked = reports.filter((r) => !r.available);
  let nextResetAt = null;
  let resetConfidence = "provider";
  if (!available.length) {
    for (const r of blocked) {
      resetConfidence = weakerConfidence(resetConfidence, r.reset_confidence || "unknown");
      if (r.available_at == null) {
        resetConfidence = weakerConfidence(resetConfidence, "unknown");
        continue;
      }
      if (nextResetAt == null || Date.parse(r.available_at) < Date.parse(nextResetAt)) {
        nextResetAt = r.available_at;
        // Prefer the confidence of the earliest-reset candidate, but never
        // inflate above what that candidate reported.
        resetConfidence = weakerConfidence(r.reset_confidence || "unknown", resetConfidence);
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
