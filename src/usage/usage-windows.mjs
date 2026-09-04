// usage-windows.mjs — shared window gating, reset expiry, freshness checks.

const MONTH = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Conservative max age per window key when resets_at is missing (hot windows only). */
export const WINDOW_MAX_AGE_MS = {
  "claude:session": 5 * 3_600_000,
  "claude:5h": 5 * 3_600_000,
  "claude:week": 7 * 86_400_000,
  "claude:fable-week": 7 * 86_400_000,
  "codex:weekly": 7 * 86_400_000,
  "codex:5h": 5 * 3_600_000,
  "cursor:included": 30 * 86_400_000,
  "cursor:auto": 30 * 86_400_000,
  "cursor:api": 30 * 86_400_000,
};

export function windowMaxAgeMs(wkey) {
  if (WINDOW_MAX_AGE_MS[wkey]) return WINDOW_MAX_AGE_MS[wkey];
  const prefix = wkey.split(":")[0];
  if (prefix === "claude") return 7 * 86_400_000;
  if (prefix === "codex") return 7 * 86_400_000;
  if (prefix === "cursor") return 30 * 86_400_000;
  return 7 * 86_400_000;
}

function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Codex renders "HH:MM on D Mon" in the machine's local wall time (not UTC). */
function parseCodexResetLocal(str, now, timeZone = localTimeZone()) {
  const m = /^(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]+)/i.exec(str.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const day = Number(m[3]);
  const month = MONTH[m[4].toLowerCase().slice(0, 3)];
  if (month === undefined) return null;
  const baseYear = new Date(now).getUTCFullYear();
  for (const year of [baseYear, baseYear + 1, baseYear - 1]) {
    try {
      const ts = zonedWallTimeToUtc({ year, month, day, hour, minute }, timeZone);
      if (Number.isFinite(ts) && ts >= now - 60_000) return ts;
      if (Number.isFinite(ts) && year === baseYear + 1) return ts;
    } catch {
      // invalid IANA zone → fall through
    }
  }
  let ts = Date.UTC(baseYear, month, day, hour, minute, 0);
  if (ts < now) ts = Date.UTC(baseYear + 1, month, day, hour, minute, 0);
  return ts;
}

function zonedWallTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  // Find UTC ms whose wall clock in `timeZone` matches the desired local time.
  let guess = Date.UTC(year, month, day, hour, minute, 0);
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, p.value])
    );
    const asIfUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second || 0)
    );
    const desired = Date.UTC(year, month, day, hour, minute, 0);
    const delta = desired - asIfUtc;
    if (delta === 0) return guess;
    guess += delta;
  }
  return guess;
}

/** Claude-style: "Jul 25, 8:10pm (Europe/Berlin)" → epoch ms. */
function parseClaudeResetLocal(str, now) {
  const m =
    /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*(?:\(([^)]+)\))?$/i.exec(
      str.trim()
    );
  if (!m) return null;
  const month = MONTH[m[1].toLowerCase().slice(0, 3)];
  if (month === undefined) return null;
  let hour = Number(m[3]) % 12;
  if (m[5].toLowerCase() === "pm") hour += 12;
  const minute = Number(m[4]);
  const day = Number(m[2]);
  const timeZone = (m[6] || "UTC").trim();
  const baseYear = new Date(now).getUTCFullYear();
  for (const year of [baseYear, baseYear + 1, baseYear - 1]) {
    try {
      const ts = zonedWallTimeToUtc({ year, month, day, hour, minute }, timeZone);
      if (Number.isFinite(ts) && ts >= now - 60_000) return ts;
      if (Number.isFinite(ts) && year === baseYear + 1) return ts;
    } catch {
      // invalid IANA zone → fall through
    }
  }
  let ts = Date.UTC(baseYear, month, day, hour, minute, 0);
  if (ts < now) ts = Date.UTC(baseYear + 1, month, day, hour, minute, 0);
  return ts;
}

/** Calendar date of an instant, as read in a given zone. */
function zonedDateParts(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  );
  return { year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day) };
}

/** Cursor renders a bare month and day, "Sep 27" — the next time it comes round. */
function parseMonthDayLocal(str, now, timeZone = localTimeZone()) {
  const m = /^([A-Za-z]{3,})\s+(\d{1,2})$/.exec(str.trim());
  if (!m) return null;
  const month = MONTH[m[1].toLowerCase().slice(0, 3)];
  if (month === undefined) return null;
  const day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  const baseYear = zonedDateParts(now, timeZone).year;
  for (const year of [baseYear, baseYear + 1]) {
    const ts = zonedWallTimeToUtc({ year, month, day, hour: 0, minute: 0 }, timeZone);
    if (Number.isFinite(ts) && ts >= now - 60_000) return ts;
  }
  return null;
}

/** Codex renders its 5h reset as a bare wall clock, "19:41" — today or tomorrow. */
function parseBareTimeLocal(str, now, timeZone = localTimeZone()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const today = zonedDateParts(now, timeZone);
  // Tomorrow by calendar arithmetic rather than +24h: a DST day is 23 or 25
  // hours long, and adding a fixed day across one lands on the wrong date.
  const next = new Date(Date.UTC(today.year, today.month, today.day) + 86_400_000);
  const days = [
    today,
    { year: next.getUTCFullYear(), month: next.getUTCMonth(), day: next.getUTCDate() },
  ];
  for (const d of days) {
    const ts = zonedWallTimeToUtc({ ...d, hour, minute }, timeZone);
    if (Number.isFinite(ts) && ts >= now - 60_000) return ts;
  }
  return null;
}

const YEAR_MS = 365 * 86_400_000;

/** Best-effort parse of CLI /usage reset strings. null = unknown (no timed expiry). */
export function parseResetAt(str, now = Date.now(), opts = {}) {
  if (!str || typeof str !== "string") return null;
  const trimmed = str.trim();
  const timeZone = opts.timeZone ?? localTimeZone();
  const direct = Date.parse(trimmed);
  // `Date.parse` accepts partial dates and invents the missing year: "Sep 27"
  // comes back as 2001-09-27, a reset permanently in the past. A real reset is
  // always near now, so anything further out belongs to the branches below.
  if (Number.isFinite(direct) && Math.abs(direct - now) < YEAR_MS) return direct;
  return (
    parseClaudeResetLocal(trimmed, now) ??
    parseCodexResetLocal(trimmed, now, timeZone) ??
    parseMonthDayLocal(trimmed, now, timeZone) ??
    parseBareTimeLocal(trimmed, now, timeZone)
  );
}

/** Convert raw reset string to ISO-8601 or null. Inject `now` for year rollover tests. */
export function normalizeResetAt(raw, now = Date.now()) {
  const ms = parseResetAt(raw, typeof now === "string" ? Date.parse(now) : now);
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * Normalize a collector window record to the shared reset contract.
 * Never invents a reset from staleness fallback.
 */
export function normalizeWindowRecord(windowKey, partial, opts = {}) {
  const nowIso = opts.now || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const raw =
    partial.resets_at_raw != null
      ? partial.resets_at_raw
      : partial.resets_at && !/^\d{4}-\d{2}-\d{2}T/.test(String(partial.resets_at))
        ? partial.resets_at
        : partial.resets_at_raw ?? null;
  let iso = null;
  if (partial.resets_at && /^\d{4}-\d{2}-\d{2}T/.test(String(partial.resets_at))) {
    iso = partial.resets_at;
  } else if (raw) {
    iso = normalizeResetAt(raw, nowMs);
  }
  const confidence = partial.reset_confidence ?? (iso ? "provider" : "unknown");
  const updatedAt = partial.updated_at || partial.updated || nowIso;
  return {
    window: windowKey.includes(":") ? windowKey.split(":").slice(1).join(":") : windowKey,
    used: partial.used,
    resets_at: iso,
    resets_at_raw: raw,
    reset_confidence: confidence,
    updated_at: updatedAt,
    source: partial.source || "unknown",
    updated: updatedAt,
  };
}

/** Burst-type windows (session/5h) reset in hours, not days — waiting one out
 * is cheap, unlike a blown weekly/monthly quota, so they hand off earlier. */
function isBurstWindow(wkey) {
  return /:(5h|session)$/.test(wkey);
}

/**
 * Resolve the handoff threshold for one window key. `handoff_at_burst`
 * (default 0.8) applies to 5h/session windows; `handoff_at` (default 0.95)
 * applies to everything else (week/weekly/monthly). Accepts either a limits
 * object ({handoff_at, handoff_at_burst}) or a bare number for callers that
 * don't distinguish window types (legacy scalar path).
 */
export function resolveHandoffAt(wkey, limits) {
  if (typeof limits === "number") return limits;
  const handoffAt = limits?.handoff_at ?? 0.95;
  const burstAt = limits?.handoff_at_burst ?? 0.8;
  return isBurstWindow(wkey) ? burstAt : handoffAt;
}

/**
 * When resets_at is missing/unparseable, windows at/over their handoff
 * threshold still expire after windowMaxAgeMs from updated so 100% readings
 * cannot stick forever.
 */
export function effectiveResetAt(w, wkey, limits = 0.95, now = Date.now()) {
  if (w?.resets_at && /^\d{4}-\d{2}-\d{2}T/.test(String(w.resets_at))) {
    const isoMs = Date.parse(w.resets_at);
    if (Number.isFinite(isoMs)) return isoMs;
  }
  const parsed = parseResetAt(w?.resets_at_raw || w?.resets_at, now);
  if (parsed !== null) return parsed;
  const handoffAt = resolveHandoffAt(wkey, limits);
  if (typeof w?.used !== "number" || w.used < handoffAt) return null;
  const updated = Date.parse(w?.updated_at || w?.updated || "");
  if (!Number.isFinite(updated)) return null;
  return updated + windowMaxAgeMs(wkey);
}

/** Window blocks only when used ≥ threshold AND reset/staleness ceiling has not passed. */
export function windowIsBlocking(wkey, usage, limits, now = Date.now()) {
  const w = usage?.windows?.[wkey];
  if (!w || typeof w.used !== "number") return false;
  const resetAt = effectiveResetAt(w, wkey, limits, now);
  if (resetAt !== null && now >= resetAt) return false;
  return w.used >= resolveHandoffAt(wkey, limits);
}

/**
 * Per-model usage gate: window data for THIS model's keys when present
 * (each resolves its own burst-vs-regular threshold); otherwise legacy
 * provider/cli scalars gated on the flat `handoff_at`.
 * @returns {{ blocked: boolean, reason?: string }}
 */
export function modelUsageGate({ usage, limitWindows, provider, cli, limits, now = Date.now() }) {
  const windows = Array.isArray(limitWindows) ? limitWindows : [];
  const withData = windows.filter((k) => usage?.windows?.[k] != null);
  if (withData.length > 0) {
    for (const wkey of withData) {
      if (windowIsBlocking(wkey, usage, limits, now)) {
        const used = usage.windows[wkey].used;
        return { blocked: true, reason: `window ${wkey} at ${Math.round(used * 100)}%` };
      }
      const drain = windowIsDraining(wkey, usage, limits, now);
      if (drain) {
        const used = usage.windows[wkey].used;
        return {
          blocked: true,
          reason:
            `window ${wkey} at ${Math.round(used * 100)}% and burning ` +
            `${(drain.per_min * 100).toFixed(1)}%/min — projected ` +
            `${Math.round(drain.projected * 100)}% in ${drain.horizon_min}min ` +
            `(in use elsewhere)`,
        };
      }
    }
    return { blocked: false };
  }
  const handoffAt = typeof limits === "number" ? limits : limits?.handoff_at ?? 0.95;
  const used = usage?.providers?.[provider]?.used;
  if (typeof used === "number" && used >= handoffAt) {
    return { blocked: true, reason: `provider ${provider} at ${Math.round(used * 100)}%` };
  }
  const cliUsed = usage?.providers?.[cli]?.used;
  if (typeof cliUsed === "number" && cliUsed >= handoffAt) {
    return { blocked: true, reason: `cli ${cli} at ${Math.round(cliUsed * 100)}%` };
  }
  return { blocked: false };
}

/** True when any window for this subscription CLI was updated within maxAgeMs. */
export function isCliUsageFresh(cli, usage, maxAgeMs = 5 * 60_000, now = Date.now()) {
  const prefix = `${cli}:`;
  let newest = 0;
  for (const [k, v] of Object.entries(usage?.windows || {})) {
    if (!k.startsWith(prefix)) continue;
    const t = Date.parse(v?.updated || "");
    if (Number.isFinite(t)) newest = Math.max(newest, t);
  }
  return newest > 0 && now - newest < maxAgeMs;
}

/** Samples kept per window for the burn-rate trend. */
const HISTORY_MAX = 12;
const HISTORY_MAX_AGE_MS = 3 * 3_600_000;
/** Oldest sample a rate may reach back to, and the shortest span it trusts. */
const RATE_SPAN_MS = 45 * 60_000;
const RATE_MIN_SPAN_MS = 5 * 60_000;

/**
 * Append one reading to a window's sample ring.
 * A drop means the window reset — the old samples describe a spent quota, so
 * the ring starts over rather than averaging across the boundary.
 * ponytail: fail-open — for the first samples after a reset there is no rate,
 * so the drain gate below stays quiet until a span rebuilds.
 */
export function pushSample(history, { used, at }) {
  const t = typeof at === "number" ? at : Date.parse(at);
  if (typeof used !== "number" || !Number.isFinite(t)) return history || [];
  const prior = (Array.isArray(history) ? history : [])
    .filter((s) => Number.isFinite(s?.at) && typeof s?.used === "number" && s.at < t)
    .filter((s) => t - s.at <= HISTORY_MAX_AGE_MS);
  const last = prior[prior.length - 1];
  const kept = last && used < last.used ? [] : prior;
  return [...kept, { at: t, used }].slice(-HISTORY_MAX);
}

/**
 * Usage burn per millisecond over the recent samples, or null when unknown.
 * Never negative: a decrease is a reset, not negative consumption.
 */
export function burnRate(w, now = Date.now()) {
  const samples = (Array.isArray(w?.history) ? w.history : []).filter(
    (s) => Number.isFinite(s?.at) && typeof s?.used === "number" && now - s.at <= RATE_SPAN_MS
  );
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.at - first.at;
  if (dt < RATE_MIN_SPAN_MS) return null;
  return Math.max(0, (last.used - first.used) / dt);
}

/**
 * Routing-only gate: a burst window that reaches its handoff threshold within
 * the projection horizon at the current burn rate. Catches a subscription
 * someone else is draining right now — another session, or another machine on
 * the same account, which no local process count can see. Deliberately not
 * part of windowIsBlocking: checkThresholds would turn a merely climbing
 * window into a full handoff and stop work that still has quota.
 * @returns {{ projected: number, per_min: number, horizon_min: number }|null}
 */
export function windowIsDraining(wkey, usage, limits, now = Date.now()) {
  if (!isBurstWindow(wkey)) return null;
  const w = usage?.windows?.[wkey];
  if (!w || typeof w.used !== "number") return null;
  const horizonMs = (limits?.project_min ?? 30) * 60_000;
  if (!(horizonMs > 0)) return null;
  const resetAt = effectiveResetAt(w, wkey, limits, now);
  if (resetAt !== null && now >= resetAt) return null;
  // Never project past the reset: quota the window gets back is not burnt.
  const horizon = resetAt === null ? horizonMs : Math.min(horizonMs, resetAt - now);
  const rate = burnRate(w, now);
  if (rate === null || rate <= 0) return null;
  const projected = w.used + rate * horizon;
  if (projected < resolveHandoffAt(wkey, limits)) return null;
  return { projected, per_min: rate * 60_000, horizon_min: Math.round(horizon / 60_000) };
}
