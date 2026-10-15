import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractFindings,
  isActionableFinding,
  meanAndSd,
  cohensD,
  analyzePickSkips,
  estimateNativeBaselineTokens,
} from "../../scripts/review-effectiveness.mjs";

test("extractFindings reads capsule RESULT.json axes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-rev-eff-"));
  fs.mkdirSync(path.join(dir, "mailbox"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "mailbox", "RESULT.json"),
    JSON.stringify({
      schema: "team-up.result/v1",
      spec_findings: [{ id: "SPEC-1", severity: "medium" }],
      standards_findings: [{ id: "STD-1", kind: "judgement_call" }],
    }),
  );
  const findings = extractFindings({ runDir: dir, state: {} });
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, "medium");
  assert.equal(findings[1].severity, "info");
});

test("extractFindings parses plain markdown finding headers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-rev-eff-"));
  fs.mkdirSync(path.join(dir, "mailbox"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "mailbox", "RESULT.md"),
    "## 2. Findings\n\n### P-1 — HIGH — settings\n\n### P2-1: MEDIUM: past period\n",
  );
  const findings = extractFindings({ runDir: dir, state: {} });
  assert.deepEqual(findings.map((f) => f.id), ["P-1", "P2-1"]);
  assert.ok(isActionableFinding(findings[0]));
  assert.ok(isActionableFinding(findings[1]));
});

test("cohensD and pick skip rate", () => {
  const a = meanAndSd([10, 12, 14]);
  const b = meanAndSd([6, 8]);
  assert.ok(cohensD(a, b) > 0);
  const skips = analyzePickSkips([
    { runId: "a", picks: [{ cli: "codex", model: "x", skipped: [{ reason: "hot" }] }] },
    { runId: "b", picks: [{ cli: "claude", model: "y", skipped: [] }] },
  ]);
  assert.equal(skips.n_dispatches_with_picks, 2);
  assert.equal(skips.n_skipped_head, 1);
  assert.equal(skips.rate, 0.5);
});

test("native baseline estimate adds fixed overhead to prompt", () => {
  const est = estimateNativeBaselineTokens({ estimated_fixed_overhead_tokens: 1000 }, 400);
  assert.equal(est.estimated_tokens, 1000 + 100);
});
