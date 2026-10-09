import { pick, limits } from "../roster/chain.mjs";
import { SESSION_PREFIX } from "./projects.mjs";
import { DEFAULT_UNCOLLECTED_DAYS } from "../runs/collect.mjs";

const WAITING_HUMAN = new Set(["waiting_human", "waiting_decision"]);

export { RUN_ID_PATTERN, isValidRunId } from "../runs/runs.mjs";

const SECRET_KEY = /key|token|secret|password/i;

/** Strip credential-like keys from objects returned to the dashboard. */
export function sanitizeForDashboard(value, { stripAccounts = false } = {}) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeForDashboard(v, { stripAccounts }));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) continue;
    if (stripAccounts && k === "accounts") continue;
    if (typeof v === "object" && v !== null) {
      out[k] = sanitizeForDashboard(v, { stripAccounts });
    } else {
      out[k] = v;
    }
  }
  return out;
}

function ageMs(iso, now) {
  if (!iso) return null;
  const ms = now - Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function formatAge(ms) {
  if (ms == null || ms < 0) return null;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

export function buildRunRow(state, { heartbeatMtimeMs = null, now = Date.now() } = {}) {
  const createdMs = ageMs(state.createdAt, now);
  const updatedMs = ageMs(state.updatedAt, now);
  const heartbeatMs = heartbeatMtimeMs != null ? now - heartbeatMtimeMs : null;
  const worker = state.worker || {};
  const cliModel = worker.cli
    ? `${worker.cli}${worker.model ? `:${worker.model}` : ""}`
    : null;
  return {
    runId: state.runId,
    role: state.role,
    status: state.status,
    worker: cliModel,
    cwd: state.cwd,
    project: state.project,
    age: formatAge(createdMs),
    ageMs: createdMs,
    updatedAge: formatAge(updatedMs),
    heartbeatAge: formatAge(heartbeatMs),
    heartbeatAgeMs: heartbeatMs,
    active: !TERMINAL.has(state.status),
    // Same window as `team-up runs uncollected`: hundreds of runs predate
    // collection and would otherwise sit in this count forever.
    uncollected: ["done", "failed"].includes(state.status) && !state.collected
      && Date.parse(state.finishedAt ?? "") >= now - DEFAULT_UNCOLLECTED_DAYS * 86_400_000,
  };
}

export function buildRunsView(states, { activeOnly = false, heartbeats = {}, now = Date.now() } = {}) {
  let rows = states.map((s) =>
    buildRunRow(s, { heartbeatMtimeMs: heartbeats[s.runId] ?? null, now }),
  );
  // Counted over every run, so the overview needs no full list on each poll.
  const counts = {
    active: rows.filter((r) => r.active).length,
    waiting: rows.filter((r) => WAITING_HUMAN.has(r.status)).length,
    uncollected: rows.filter((r) => r.uncollected).length,
    failedUncollected: rows.filter((r) => r.uncollected && r.status === "failed").length,
  };
  // "Open" = still running or finished with nobody having read the result.
  if (activeOnly) rows = rows.filter((r) => r.active || r.uncollected);
  rows.sort((a, b) => (b.ageMs ?? 0) - (a.ageMs ?? 0));
  return { runs: rows, counts, now: new Date(now).toISOString() };
}

export function joinTmuxSessions(sessions, states) {
  const bySession = new Map();
  for (const state of states) {
    if (TERMINAL.has(state.status)) continue;
    const tmux = state.worker?.tmux;
    if (tmux) {
      bySession.set(tmux, {
        runId: state.runId,
        role: state.role,
        status: state.status,
      });
    }
  }
  const joined = sessions.map((name) => ({
    session: name,
    runId: bySession.get(name)?.runId ?? null,
    role: bySession.get(name)?.role ?? null,
    status: bySession.get(name)?.status ?? null,
    // A session started from the Projects panel has no run by design, so it is
    // not a leftover worker — flagging it would make the warning meaningless.
    orphan: !bySession.has(name) && !name.startsWith(SESSION_PREFIX),
  }));
  const orphans = joined.filter((s) => s.orphan);
  return { sessions: joined, orphans };
}

export function usageStaleThresholdMs(roster) {
  const activeMin = roster?.usage_watcher?.intervals?.active_min;
  if (activeMin == null || !Number.isFinite(activeMin)) return 40 * 60_000;
  return 2 * activeMin * 60_000;
}

export function classifyUsageWindow(info, roster, now = Date.now()) {
  const roleLimits = limits(roster);
  const used = typeof info?.used === "number" ? info.used : null;
  let level = "ok";
  if (used != null) {
    if (used >= roleLimits.handoff_at) level = "red";
    else if (used >= roleLimits.warn_at) level = "amber";
  }
  let stale = false;
  const updatedAt = info?.updated_at;
  if (updatedAt) {
    const updatedMs = Date.parse(updatedAt);
    if (Number.isFinite(updatedMs)) {
      const threshold = usageStaleThresholdMs(roster);
      stale = now - updatedMs > threshold;
    }
  }
  return {
    used,
    usedPct: used != null ? Math.round(used * 100) : null,
    resets_at: info?.resets_at ?? null,
    updated_at: updatedAt ?? null,
    level,
    stale,
  };
}

/**
 * Consecutive auth failures at the tail of the ring. The ring is emptied on a
 * successful collect (tickOnce), so every entry is a failure since the last
 * good reading; only a tail streak means "still failing on login now".
 */
function authFailureStreak(list) {
  let n = 0;
  for (let i = list.length - 1; i >= 0 && list[i]?.reason === "auth_failure"; i -= 1) n += 1;
  return n;
}

/** Same threshold as usage-watchdog.mjs FAILURE_REPEAT, and <= COLLECT_FAILURE_RING. */
export const AUTH_FAILURE_STREAK = 3;

/**
 * Per-CLI collector health. A window goes STALE because its collector stopped
 * succeeding, so the reason lives in the watcher's state, not in usage.json —
 * surfacing it here is what turns a bare STALE badge into something actionable.
 * auth_failure is kept apart from the parse reasons: a dead login is an account
 * problem no repair agent can fix, and the dashboard has to say which it is.
 */
export function buildCollectorView(watcher, repairs = {}) {
  const lastCollect = watcher?.last_collect || {};
  const failures = watcher?.collect_failures || {};
  const out = {};
  for (const cli of new Set([...Object.keys(lastCollect), ...Object.keys(failures)])) {
    const list = Array.isArray(failures[cli]) ? failures[cli] : [];
    const last = list.length ? list[list.length - 1] : null;
    const authStreak = authFailureStreak(list);
    out[cli] = {
      last_collect: lastCollect[cli] ?? null,
      failure_count: list.length,
      last_failure_at: last?.at ?? null,
      last_reason: last?.reason ?? null,
      auth_failure: authStreak > 0,
      auth_failure_streak: authStreak,
      // Suggest only. The 2026-09-23 cursor collector bug produced this exact
      // shape while the subscription was healthy — an auto-flip would have
      // disabled a paid, working account on its own.
      suggest_disable: authStreak >= AUTH_FAILURE_STREAK,
      repair: repairs[cli] ?? { running: false, session: null, started_at: null },
    };
  }
  return out;
}

export function buildUsageView(usage, roster, now = Date.now(), { watcher = null, repairs = {} } = {}) {
  const windows = {};
  for (const [key, info] of Object.entries(usage?.windows || {})) {
    windows[key] = classifyUsageWindow(info, roster, now);
  }
  const marked = [];
  for (const [key, mark] of Object.entries(usage?.marked || {})) {
    if (mark?.until && Date.parse(mark.until) > now) {
      marked.push({ key, until: mark.until, reason: mark.reason ?? null });
    }
  }
  marked.sort((a, b) => a.key.localeCompare(b.key));
  return {
    windows,
    marked,
    updated: usage?.updated ?? null,
    limits: limits(roster),
    staleThresholdMin: usageStaleThresholdMs(roster) / 60_000,
    collectors: buildCollectorView(watcher, repairs),
    now: new Date(now).toISOString(),
  };
}

export function buildPickAllView(roster, usage, now = Date.now()) {
  const roles = roster?.roles || {};
  const picks = [];
  for (const role of Object.keys(roles).sort()) {
    const result = pick({ roster, usage, role, now });
    picks.push({
      role,
      model: result.model,
      cli: result.cli,
      effort: result.effort ?? null,
      skipped: result.skipped,
    });
  }
  return sanitizeForDashboard({ picks, now: new Date(now).toISOString() }, { stripAccounts: true });
}


export function readMailboxFiles(runId, { readFile, runRoot, maxBytes = 256 * 1024 }) {
  const files = ["PROMPT.md", "STATUS", "RESULT.md"];
  const out = {};
  for (const name of files) {
    const content = readFile(name, runRoot);
    if (content == null) continue;
    if (Buffer.byteLength(content) > maxBytes) {
      out[name] = Buffer.from(content).subarray(0, maxBytes).toString("utf8") + "\n… [truncated]";
    } else {
      out[name] = content;
    }
  }
  return out;
}
