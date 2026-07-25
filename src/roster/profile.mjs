import { modelUsageGate } from "../usage/usage-windows.mjs";
import { limits } from "./chain.mjs";
import { defaultHarnessCapabilities } from "../harness/registry.mjs";
import { COMMAND_BROKER_CAPABILITY } from "../harness/capabilities.mjs";

const TIER_ALIASES = { mid: "medium" };
const VALID_TIERS = new Set(["frontier", "high", "medium", "low"]);
const VALID_REASONING = new Set(["max", "high", "medium", "low"]);

export function normalizeTier(tier) {
  if (tier == null) return tier;
  const t = TIER_ALIASES[tier] || tier;
  if (!VALID_TIERS.has(t)) {
    throw new Error(`unknown tier: ${tier} (expected frontier|high|medium|low)`);
  }
  return t;
}

export function parseProfileString(s) {
  const m = /^([^:]+):(.+)$/.exec(String(s || "").trim());
  if (!m) throw new Error(`invalid profile: ${s} (use <tier>:<reasoning>)`);
  const tier = normalizeTier(m[1]);
  const reasoning = m[2];
  if (!VALID_REASONING.has(reasoning)) {
    throw new Error(`unknown reasoning: ${reasoning} (expected max|high|medium|low)`);
  }
  return { tier, reasoning };
}

function markedUntil(usage, key, now) {
  const until = usage?.marked?.[key]?.until;
  if (!until) return false;
  return Date.parse(until) > now;
}

/**
 * Resolve abstract {tier, reasoning} into an exact-tier fallback chain.
 * Never upgrades or downgrades tier.
 * Optional requirements (e.g. command_broker) filter harnesses after CLI
 * template validation and before usage gates.
 */
export function resolveProfile({
  roster,
  profile,
  usage = {},
  specialistId,
  callType,
  now = Date.now(),
  requirements = {},
  harnessCapabilities = defaultHarnessCapabilities,
}) {
  const effective =
    roster?.specialists?.[specialistId]?.calls?.[callType]?.model_profile ||
    roster?.specialists?.[specialistId]?.model_profile ||
    profile;

  if (!effective?.tier || !effective?.reasoning) {
    return {
      code: "PROFILE_UNAVAILABLE",
      profile: effective || null,
      chain: [],
      skipped: [{ model: "*", reason: "missing tier or reasoning on profile" }],
    };
  }

  let tier;
  try {
    tier = normalizeTier(effective.tier);
  } catch (e) {
    return {
      code: "PROFILE_UNAVAILABLE",
      profile: effective,
      chain: [],
      skipped: [{ model: "*", reason: e.message }],
    };
  }

  if (!VALID_REASONING.has(effective.reasoning)) {
    return {
      code: "PROFILE_UNAVAILABLE",
      profile: effective,
      chain: [],
      skipped: [{ model: "*", reason: `unknown reasoning: ${effective.reasoning}` }],
    };
  }

  const roleLimits = limits(roster || {});
  const chain = [];
  const skipped = [];
  const requiredBroker = requirements?.command_broker || null;

  for (const [model, spec] of Object.entries(roster?.models || {})) {
    const modelTier = (() => {
      try {
        return normalizeTier(spec.tier);
      } catch {
        return null;
      }
    })();
    if (modelTier !== tier) {
      skipped.push({ model, reason: `tier ${spec.tier} != ${tier}` });
      continue;
    }

    const accountId = spec.account;
    if (!accountId) {
      skipped.push({ model, reason: "no account" });
      continue;
    }
    {
      const account = roster.accounts?.[accountId];
      if (!account?.enabled) {
        skipped.push({ model, reason: "account unavailable" });
        continue;
      }
      if (account.kind === "credit" && !(account.remaining > 0)) {
        skipped.push({ model, reason: "account unavailable" });
        continue;
      }
    }

    const reasoningMap = spec.reasoning || {};
    if (!(effective.reasoning in reasoningMap)) {
      skipped.push({ model, reason: `no reasoning mapping for ${effective.reasoning}` });
      continue;
    }

    const clis = spec.cli || [];
    if (!clis.length) {
      skipped.push({ model, reason: "no cli resolved" });
      continue;
    }

    for (const cli of clis) {
      if (!roster.clis?.[cli]?.cmd) {
        skipped.push({ model: `${cli}:${model}`, reason: `no cli template for "${cli}"` });
        continue;
      }

      if (requiredBroker) {
        let caps;
        try {
          caps = harnessCapabilities(cli);
        } catch {
          caps = { command_broker: null };
        }
        if (caps?.command_broker !== requiredBroker) {
          skipped.push({
            model: `${cli}:${model}`,
            reason: `command broker unavailable (need ${requiredBroker})`,
          });
          continue;
        }
      }

      // Usage / mark gates — exact same provider/CLI gate as legacy pick()
      const limitWindows = Array.isArray(spec.limit_windows) ? spec.limit_windows : [];
      const gate = modelUsageGate({
        usage,
        limitWindows,
        provider: spec.provider,
        cli,
        limits: roleLimits,
        now,
      });
      if (gate.blocked) {
        skipped.push({ model: `${cli}:${model}`, reason: gate.reason });
        continue;
      }
      if (markedUntil(usage, model, now)) {
        skipped.push({ model: `${cli}:${model}`, reason: `marked limited until ${usage.marked[model].until}` });
        continue;
      }
      if (spec.provider && markedUntil(usage, spec.provider, now)) {
        skipped.push({
          model: `${cli}:${model}`,
          reason: `provider marked limited until ${usage.marked[spec.provider].until}`,
        });
        continue;
      }
      if (markedUntil(usage, cli, now)) {
        skipped.push({ model: `${cli}:${model}`, reason: `cli marked limited until ${usage.marked[cli].until}` });
        continue;
      }

      chain.push({
        cli,
        model,
        effort: reasoningMap[effective.reasoning],
        priority: spec.priority ?? 100,
      });
    }
  }

  chain.sort(
    (a, b) =>
      a.priority - b.priority || `${a.cli}:${a.model}`.localeCompare(`${b.cli}:${b.model}`)
  );

  return chain.length
    ? { code: "OK", profile: { tier, reasoning: effective.reasoning }, chain, skipped }
    : { code: "PROFILE_UNAVAILABLE", profile: { tier, reasoning: effective.reasoning }, chain: [], skipped };
}

export { COMMAND_BROKER_CAPABILITY };
