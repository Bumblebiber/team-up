import {
  accountBlockReason, parseChainEntry, resolveEffort, evaluateUsageAndMarkGate,
} from "./chain.mjs";
import { defaultHarnessCapabilities } from "../harness/registry.mjs";
import { COMMAND_BROKER_CAPABILITY } from "../harness/capabilities.mjs";

/**
 * A specialist's assignment from the roster: `{ role }` runs it on that role's
 * chain, `{ chain }` on a chain of its own. Null when it has neither.
 */
export function specialistAssignment(roster, specialistId) {
  const spec = roster?.specialists?.[specialistId];
  if (spec?.role) return { role: spec.role };
  if (Array.isArray(spec?.chain)) return { chain: spec.chain };
  return null;
}

/**
 * Resolve a specialist's assignment (see `specialistAssignment`) into its
 * fallback chain, in chain order. An `override` ({ model, cli? }) replaces the
 * chain with that one cell. Every cell still passes the CLI template, harness
 * capability (`requirements`, e.g. command_broker), account and usage gates, so
 * an override narrows, never bypasses.
 */
export function resolveProfile({
  roster,
  profile,
  usage = {},
  specialistId,
  now = Date.now(),
  requirements = {},
  harnessCapabilities = defaultHarnessCapabilities,
  override = null,
}) {
  // A run launched before roles replaced tiers stored {tier, reasoning}; it
  // re-resolves through the specialist's current assignment.
  const assignment = profile?.role || profile?.chain ? profile : specialistAssignment(roster, specialistId);
  const role = assignment?.role ?? null;
  const fail = (reason) => ({
    code: "PROFILE_UNAVAILABLE",
    profile: assignment || null,
    chain: [],
    skipped: [{ model: "*", reason }],
    quota_blocked: [],
  });

  let rawChain;
  if (override?.model) rawChain = [override.cli ? { model: override.model, cli: override.cli } : override.model];
  else if (role) rawChain = roster?.roles?.[role]?.chain;
  else rawChain = assignment?.chain;
  if (!override?.model && !assignment) {
    return fail(`no role or chain assigned to ${specialistId || "this specialist"} — assign one in the dashboard`);
  }
  if (!Array.isArray(rawChain) || !rawChain.length) {
    return fail(role ? `role ${role} has no chain` : "empty chain");
  }

  const chain = [];
  const skipped = [];
  const quota_blocked = [];
  const requiredCaps = Object.entries(requirements || {})
    .filter(([, value]) => value != null);

  for (const [index, raw] of rawChain.entries()) {
    let entry;
    try {
      entry = parseChainEntry(raw);
    } catch (e) {
      skipped.push({ model: String(raw?.model ?? raw), reason: e.message });
      continue;
    }
    const { model } = entry;
    const spec = roster?.models?.[model];
    if (!spec) {
      skipped.push({ model, reason: "not in models" });
      continue;
    }
    // Same rule as role dispatch: a chain entry is human intent, so only a
    // declared account that is disabled or out of credit bars it.
    if (accountBlockReason(roster, spec.account)) {
      skipped.push({ model, reason: "account unavailable" });
      continue;
    }
    if (entry.cli && !(spec.cli || []).includes(entry.cli)) {
      skipped.push({ model: `${entry.cli}:${model}`, reason: `${model} does not run on ${entry.cli}` });
      continue;
    }

    const clis = entry.cli ? [entry.cli] : (spec.cli || []);
    if (!clis.length) {
      skipped.push({ model, reason: "no cli resolved" });
      continue;
    }

    for (const cli of clis) {
      if (!roster.clis?.[cli]?.cmd) {
        skipped.push({ model: `${cli}:${model}`, reason: `no cli template for "${cli}"` });
        continue;
      }

      if (requiredCaps.length > 0) {
        let caps;
        try {
          caps = harnessCapabilities(cli);
        } catch {
          caps = {};
        }
        let missing = null;
        for (const [key, required] of requiredCaps) {
          if (caps?.[key] !== required) {
            missing = { key, required };
            break;
          }
        }
        if (missing) {
          skipped.push({
            model: `${cli}:${model}`,
            reason: `${missing.key.replaceAll("_", " ")} unavailable (need ${missing.required})`,
          });
          continue;
        }
      }

      // Usage / mark gates — exact same provider/CLI gate as pick().
      // Capability-compatible quota-blocked cells are preserved for capacity
      // reporting so an exhausted chain still exposes reset information.
      const cell = {
        cli,
        model,
        effort: resolveEffort({ roster, role, model, entryEffort: entry.effort }),
        priority: index,
      };
      const gate = evaluateUsageAndMarkGate({
        roster,
        usage,
        modelId: model,
        model: spec,
        cli,
        now,
      });
      if (gate.blocked) {
        skipped.push({ model: `${cli}:${model}`, reason: gate.reason });
        quota_blocked.push({ ...cell, block_reason: gate.reason });
        continue;
      }

      chain.push(cell);
    }
  }

  return {
    code: chain.length ? "OK" : "PROFILE_UNAVAILABLE",
    profile: assignment,
    chain,
    skipped,
    quota_blocked,
  };
}

export { COMMAND_BROKER_CAPABILITY };
