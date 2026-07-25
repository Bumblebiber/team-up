import path from "node:path";
import { fileURLToPath } from "node:url";
import { modelUsageGate, windowIsBlocking, effectiveResetAt } from "../usage/usage-windows.mjs";
import { resolveEffort } from "./command.mjs";
export { resolveEffort };

export function limits(roster) {
  return { warn_at: 0.9, handoff_at: 0.95, handoff_at_burst: 0.8, ...(roster.limits || {}) };
}

function markedUntil(usage, key, now) {
  const until = usage?.marked?.[key]?.until;
  if (!until) return false;
  return Date.parse(until) > now;
}

/**
 * Parse a chain entry into {model, cli|null, effort|null}.
 */
export function parseChainEntry(entry) {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    if (typeof entry.model !== "string" || !entry.model) {
      throw new Error(`invalid chain entry object: ${JSON.stringify(entry)}`);
    }
    if (entry.effort !== undefined && entry.effort !== null && typeof entry.effort !== "string") {
      throw new Error(`invalid chain entry effort (must be a string): ${JSON.stringify(entry)}`);
    }
    return { model: entry.model, cli: entry.cli ?? null, effort: entry.effort || null };
  }
  if (typeof entry !== "string" || !entry) {
    throw new Error(`invalid chain entry: ${entry}`);
  }
  const i = entry.indexOf(":");
  if (i === -1) return { model: entry, cli: null, effort: null };
  const cli = entry.slice(0, i);
  const model = entry.slice(i + 1);
  if (!cli || !model) throw new Error(`invalid chain entry: ${entry}`);
  return { model, cli, effort: null };
}


function entryLabel(model, cli) {
  return cli ? `${cli}:${model}` : model;
}

/** Resolve usage window keys that gate a model spawn. */
export function resolveLimitWindows(_roster, modelId, model) {
  if (Array.isArray(model?.limit_windows) && model.limit_windows.length) {
    return model.limit_windows;
  }
  const out = [];
  const clis = model?.cli || [];
  if (clis.includes("claude")) {
    out.push("claude:session", "claude:week", "claude:5h");
    if (modelId.includes("fable")) out.push("claude:fable-week");
  }
  if (clis.includes("codex")) out.push("codex:weekly");
  if (clis.includes("cursor")) out.push("cursor:included");
  return out;
}

function hasWindowsData(usage) {
  return Boolean(usage?.windows && Object.keys(usage.windows).length > 0);
}

export function dispatchFreshnessMs(roster) {
  return roster?.usage_watcher?.dispatch_freshness_sec ?? 300;
}

export function pick({ roster, usage, role, now = Date.now() }) {
  const spec = roster.roles?.[role];
  if (!spec) throw new Error(`unknown role: ${role}`);
  const roleLimits = limits(roster);
  const skipped = [];

  for (const raw of spec.chain) {
    let parsed;
    try {
      parsed = parseChainEntry(raw);
    } catch (e) {
      skipped.push({ model: String(raw), reason: e.message });
      continue;
    }
    const { model: name } = parsed;
    const model = roster.models?.[name];
    if (!model) {
      skipped.push({ model: entryLabel(name, parsed.cli), reason: "not in models" });
      continue;
    }

    const cli = parsed.cli ?? model.cli?.[0] ?? null;
    const label = entryLabel(name, parsed.cli);

    if (!cli) {
      skipped.push({ model: label, reason: "no cli resolved" });
      continue;
    }
    if (!roster.clis?.[cli]?.cmd) {
      skipped.push({ model: label, reason: `no cli template for "${cli}"` });
      continue;
    }
    if (Array.isArray(model.cli) && model.cli.length > 0 && !model.cli.includes(cli)) {
      skipped.push({ model: label, reason: `cli "${cli}" not listed for model` });
      continue;
    }

    const limitWindows = resolveLimitWindows(roster, name, model);
    const gate = modelUsageGate({
      usage,
      limitWindows,
      provider: model.provider,
      cli,
      limits: roleLimits,
      now,
    });
    if (gate.blocked) {
      skipped.push({ model: label, reason: gate.reason });
      continue;
    }
    if (markedUntil(usage, name, now)) {
      skipped.push({ model: label, reason: `marked limited until ${usage.marked[name].until}` });
      continue;
    }
    if (markedUntil(usage, model.provider, now)) {
      skipped.push({ model: label, reason: `provider marked limited until ${usage.marked[model.provider].until}` });
      continue;
    }
    if (markedUntil(usage, cli, now)) {
      skipped.push({ model: label, reason: `cli marked limited until ${usage.marked[cli].until}` });
      continue;
    }
    return {
      model: name,
      cli,
      effort: resolveEffort({ roster, role, model: name, entryEffort: parsed.effort }),
      skipped,
    };
  }
  return { model: null, cli: null, effort: null, skipped };
}

export function parseTtl(str) {
  const m = /^(\d+)([mhd])$/.exec(str || "");
  if (!m) throw new Error(`invalid ttl: ${str} (use e.g. 30m, 5h, 1d)`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return Number(m[1]) * unit;
}

/** Pure: returns a new usage object with target marked until now+ttl. */
export function markLimited({ usage, target, ttlMs, now = Date.now(), reason }) {
  const base = usage ? structuredClone(usage) : {};
  base.marked = base.marked || {};
  base.marked[target] = {
    until: new Date(now + ttlMs).toISOString(),
    ...(reason ? { reason } : {}),
  };
  return base;
}

export function checkThresholds({ roster, usage, now = Date.now() }) {
  const thresholds = limits(roster);
  const { warn_at, handoff_at } = thresholds;
  const lines = [];
  let handoff = false;

  if (hasWindowsData(usage)) {
    for (const [wkey, info] of Object.entries(usage.windows)) {
      if (typeof info?.used !== "number") continue;
      const resetAt = effectiveResetAt(info, wkey, thresholds, now);
      if (resetAt !== null && now >= resetAt) continue;
      const pct = Math.round(info.used * 100);
      if (windowIsBlocking(wkey, usage, thresholds, now)) {
        lines.push(`⛔ o9k-roster: ${wkey} at ${pct}% — session limit reached.`);
        handoff = true;
      } else if (info.used >= warn_at) {
        lines.push(`⚠️ o9k-roster: ${wkey} at ${pct}% — prepare for handoff: converge to a checkpointable state.`);
      }
    }
  } else {
    for (const [provider, info] of Object.entries(usage?.providers || {})) {
      if (typeof info?.used !== "number") continue;
      const pct = Math.round(info.used * 100);
      if (info.used >= handoff_at) {
        lines.push(`⛔ o9k-roster: ${provider} at ${pct}% — session limit reached.`);
        handoff = true;
      } else if (info.used >= warn_at) {
        lines.push(`⚠️ o9k-roster: ${provider} at ${pct}% — prepare for handoff: converge to a checkpointable state.`);
      }
    }
  }
  for (const [target, mark] of Object.entries(usage?.marked || {})) {
    if (Date.parse(mark.until) > now) {
      lines.push(`ℹ️ o9k-roster: ${target} marked limited until ${mark.until}${mark.reason ? ` (${mark.reason})` : ""}`);
    }
  }
  if (handoff) {
    const rosterScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "roster.mjs");
    lines.push(
      "Do this now: (1) write HANDOFF.md in the working directory (current state, done steps, open steps, verification commands), " +
      `(2) run: node ${rosterScript} handoff --role <your role> --dir "$PWD", ` +
      "(3) report the printed tmux session + attach command to the user, (4) stop working in this session."
    );
  }
  return lines.join("\n");
}

function modelUsageBlocked({ roster, usage, modelName, cli, limits: limitsArg, now }) {
  const model = roster.models?.[modelName];
  if (!model) return false;
  return modelUsageGate({
    usage,
    limitWindows: resolveLimitWindows(roster, modelName, model),
    provider: model.provider,
    cli,
    limits: limitsArg,
    now,
  }).blocked;
}

export function resolvePickAfterRefresh({
  roster,
  preUsage,
  postUsage,
  priorPick,
  role,
  now = Date.now(),
}) {
  const roleLimits = limits(roster);
  const r2 = pick({ roster, usage: postUsage, role, now });
  if (r2.model) return r2;
  if (
    priorPick.model &&
    !modelUsageBlocked({
      roster,
      usage: preUsage,
      modelName: priorPick.model,
      cli: priorPick.cli,
      limits: roleLimits,
      now,
    }) &&
    modelUsageBlocked({
      roster,
      usage: postUsage,
      modelName: priorPick.model,
      cli: priorPick.cli,
      limits: roleLimits,
      now,
    })
  ) {
    return priorPick;
  }
  return { model: null, cli: null, effort: null, skipped: r2.skipped };
}
