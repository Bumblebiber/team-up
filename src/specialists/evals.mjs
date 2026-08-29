import fs from "node:fs";
import path from "node:path";
import { intersectPermissions } from "./permissions.mjs";
import { normalizeRequest } from "./request.mjs";

const CASE_KINDS = new Set(["positive", "anti_remit", "call_type", "malformed"]);

/**
 * Read and validate a specialist's eval suite.
 *
 * The manifest validator only ever checked that `eval_suite` was a safe
 * relative path, so a suite could be absent, empty or malformed JSON and
 * nothing noticed. That is the first thing worth catching: a suite nobody can
 * parse is not a weaker guarantee than a failing one, it is no guarantee.
 */
export function loadEvalSuite(manifest, root) {
  const rel = manifest?.eval_suite;
  if (!rel) return { ok: false, error: "manifest declares no eval_suite", cases: [] };
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    return { ok: false, error: `eval suite missing: ${rel}`, cases: [] };
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    return { ok: false, error: `eval suite unreadable: ${e.message}`, cases: [] };
  }
  if (doc?.schema_version !== 1) {
    return { ok: false, error: "unsupported eval suite schema_version", cases: [] };
  }
  const cases = Array.isArray(doc.cases) ? doc.cases : null;
  if (!cases) return { ok: false, error: "eval suite has no cases array", cases: [] };
  if (cases.length === 0) return { ok: false, error: "eval suite is empty", cases: [] };

  const errors = [];
  const seen = new Set();
  for (const [i, c] of cases.entries()) {
    const where = c?.id ? `case ${c.id}` : `case #${i}`;
    if (!c?.id) errors.push(`${where}: id required`);
    else if (seen.has(c.id)) errors.push(`${where}: duplicate id`);
    else seen.add(c.id);
    if (!CASE_KINDS.has(c?.kind)) errors.push(`${where}: unknown kind ${c?.kind}`);
    if (!c?.expect || typeof c.expect !== "object") errors.push(`${where}: expect required`);
  }
  if (errors.length) return { ok: false, error: errors.join("; "), cases };
  return { ok: true, error: null, cases };
}

/**
 * Evaluate every case that can be decided without spending a model call.
 *
 * `permissions.*` and `schema` are decided by the same code the runtime uses:
 * normalizeRequest applies the call type's defaults, intersectPermissions
 * applies the manifest's ceiling. A case asserting `status` describes what a
 * specialist *did*, which no static check can know — those are reported as
 * `live`, never as passes. Counting them as passes is how a suite becomes
 * decoration.
 */
export function runEvalSuite({ manifest, suite, specialistId }) {
  const results = [];
  for (const c of suite.cases) {
    const callType = c.call_type ?? "delegate";
    const expect = c.expect ?? {};
    const checks = [];
    let live = false;

    if (!(manifest.call_types ?? []).includes(callType)) {
      results.push({
        id: c.id,
        kind: c.kind,
        call_type: callType,
        outcome: "fail",
        reason: `manifest does not accept call_type ${callType}`,
      });
      continue;
    }

    let effective = null;
    let requestError = null;
    try {
      const request = normalizeRequest({
        call_type: callType,
        specialist_id: specialistId,
        objective: c.id,
      });
      effective = intersectPermissions(manifest.permissions, request.permissions, {
        capabilities: manifest.capabilities,
      });
    } catch (e) {
      requestError = e.message;
    }

    for (const [key, want] of Object.entries(expect)) {
      if (key === "status") {
        live = true;
        continue;
      }
      if (key === "schema") {
        checks.push({
          key,
          want,
          got: manifest.output_contract,
          ok: manifest.output_contract === want,
        });
        continue;
      }
      if (key.startsWith("permissions.")) {
        if (requestError) {
          checks.push({ key, want, got: null, ok: false, error: requestError });
          continue;
        }
        const got = effective?.[key.slice("permissions.".length)];
        checks.push({ key, want, got, ok: got === want });
        continue;
      }
      checks.push({ key, want, got: null, ok: false, error: "unknown expect key" });
    }

    const failed = checks.filter((x) => !x.ok);
    results.push({
      id: c.id,
      kind: c.kind,
      call_type: callType,
      outcome: failed.length ? "fail" : live && !checks.length ? "live" : "pass",
      live_only: live,
      checks,
    });
  }

  const failed = results.filter((r) => r.outcome === "fail");
  return {
    specialist: specialistId,
    cases: results.length,
    passed: results.filter((r) => r.outcome === "pass").length,
    failed: failed.length,
    live_only: results.filter((r) => r.outcome === "live").length,
    results,
    ok: failed.length === 0,
  };
}
