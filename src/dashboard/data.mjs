import { pick, limits } from "../roster/chain.mjs";
import { unlistedHighScorers } from "../scores/propose.mjs";

/** Run ids from `createRun` — ISO timestamp + 4-char base36 suffix. */
export const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[a-z0-9]{4}$/;

export function isValidRunId(id) {
  return typeof id === "string" && RUN_ID_PATTERN.test(id);
}

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
  };
}

export function buildRunsView(states, { activeOnly = false, heartbeats = {}, now = Date.now() } = {}) {
  let rows = states.map((s) =>
    buildRunRow(s, { heartbeatMtimeMs: heartbeats[s.runId] ?? null, now }),
  );
  if (activeOnly) rows = rows.filter((r) => r.active);
  rows.sort((a, b) => (b.ageMs ?? 0) - (a.ageMs ?? 0));
  return { runs: rows, now: new Date(now).toISOString() };
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
    orphan: !bySession.has(name),
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

export function buildUsageView(usage, roster, now = Date.now()) {
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

const MODELS_PAGE_SIZE = 200;

export function buildModelsView(scoresFile, roster, { q, in_roster, page = 0 } = {}) {
  if (!scoresFile?.models) {
    return { models: [], total: 0, page, pageSize: MODELS_PAGE_SIZE, apply_cli: "team-up apply-scores" };
  }
  const proposals = unlistedHighScorers({ roster, scoresFile });
  const proposalByModel = new Map();
  for (const p of proposals) {
    const key = p.model;
    if (!proposalByModel.has(key)) proposalByModel.set(key, p);
  }

  const query = (q || "").trim().toLowerCase();
  const rows = [];
  for (const [modelId, mod] of Object.entries(scoresFile.models)) {
    const rosterEntry = roster?.models?.[modelId] ?? null;
    const inRoster = rosterEntry != null;
    if (in_roster === true && !inRoster) continue;
    if (in_roster === false && inRoster) continue;
    const display = mod.display_name || modelId;
    if (query) {
      const hay = `${modelId} ${display} ${mod.provider || ""}`.toLowerCase();
      if (!hay.includes(query)) continue;
    }
    const account = rosterEntry?.account ?? null;
    const accountEnabled =
      account == null ? true : roster?.accounts?.[account]?.enabled !== false;
    const proposal =
      proposalByModel.get(mod.openrouter_id || modelId) ||
      proposalByModel.get(modelId) ||
      null;
    rows.push({
      model: modelId,
      display_name: display,
      provider: mod.provider ?? null,
      price: mod.price ?? null,
      scores: mod.scores ?? null,
      in_roster: inRoster,
      clis: rosterEntry?.cli ?? null,
      tier: rosterEntry?.tier ?? null,
      account,
      reasoning: rosterEntry?.reasoning ?? null,
      reachable: inRoster ? accountEnabled : null,
      proposal,
    });
  }
  rows.sort((a, b) => a.model.localeCompare(b.model));
  const total = rows.length;
  const start = page * MODELS_PAGE_SIZE;
  const models = rows.slice(start, start + MODELS_PAGE_SIZE);
  return {
    models,
    total,
    page,
    pageSize: MODELS_PAGE_SIZE,
    apply_cli: "team-up apply-scores",
  };
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
