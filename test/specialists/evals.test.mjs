import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEvalSuite, runEvalSuite } from "../../src/specialists/evals.mjs";

const MANIFEST = {
  id: "testing.example",
  call_types: ["consult", "delegate", "review"],
  output_contract: "team-up.result/v1",
  capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
  permissions: { filesystem: "project", writes: true, network: false, commands: [] },
  eval_suite: "evals/evals.json",
};

function withSuite(doc, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-evals-"));
  try {
    fs.mkdirSync(path.join(root, "evals"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "evals", "evals.json"),
      typeof doc === "string" ? doc : JSON.stringify(doc)
    );
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a suite that cannot be parsed is not a weaker guarantee, it is none", () => {
  assert.equal(withSuite("{not json", (r) => loadEvalSuite(MANIFEST, r)).ok, false);
  assert.equal(withSuite({ schema_version: 1, cases: [] }, (r) => loadEvalSuite(MANIFEST, r)).ok, false);
  assert.equal(withSuite({ schema_version: 2, cases: [{}] }, (r) => loadEvalSuite(MANIFEST, r)).ok, false);
  assert.equal(loadEvalSuite({ ...MANIFEST, eval_suite: null }, "/nowhere").ok, false);
  assert.equal(loadEvalSuite(MANIFEST, "/nowhere").ok, false);
});

test("malformed cases are named, not skipped", () => {
  const suite = withSuite(
    { schema_version: 1, cases: [
      { id: "a", kind: "positive", expect: {} },
      { id: "a", kind: "positive", expect: {} },
      { id: "b", kind: "nonsense", expect: {} },
      { id: "c", kind: "positive" },
    ] },
    (r) => loadEvalSuite(MANIFEST, r)
  );
  assert.equal(suite.ok, false);
  assert.match(suite.error, /duplicate id/);
  assert.match(suite.error, /unknown kind nonsense/);
  assert.match(suite.error, /expect required/);
});

test("a status expectation is reported live, never as a pass", () => {
  const suite = withSuite(
    { schema_version: 1, cases: [
      { id: "s", kind: "positive", call_type: "delegate", expect: { status: ["success"] } },
    ] },
    (r) => loadEvalSuite(MANIFEST, r)
  );
  const report = runEvalSuite({ manifest: MANIFEST, suite, specialistId: MANIFEST.id });
  assert.equal(report.results[0].outcome, "live");
  assert.equal(report.passed, 0);
  assert.equal(report.ok, true);
});

test("a permission expectation the manifest contradicts fails", () => {
  const suite = withSuite(
    { schema_version: 1, cases: [
      // consult defaults to writes:false, so this one holds...
      { id: "ok", kind: "call_type", call_type: "consult", expect: { "permissions.writes": false } },
      // ...and this one cannot: the manifest grants network nowhere.
      { id: "bad", kind: "call_type", call_type: "delegate", expect: { "permissions.network": true } },
    ] },
    (r) => loadEvalSuite(MANIFEST, r)
  );
  const report = runEvalSuite({ manifest: MANIFEST, suite, specialistId: MANIFEST.id });
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.ok, false);
  assert.equal(report.results[1].checks[0].got, false);
});

test("a case naming a call type the manifest refuses fails loudly", () => {
  const suite = withSuite(
    { schema_version: 1, cases: [
      { id: "x", kind: "positive", call_type: "review", expect: { schema: "team-up.result/v1" } },
    ] },
    (r) => loadEvalSuite(MANIFEST, r)
  );
  const narrowed = { ...MANIFEST, call_types: ["consult"] };
  const report = runEvalSuite({ manifest: narrowed, suite, specialistId: narrowed.id });
  assert.equal(report.results[0].outcome, "fail");
  assert.match(report.results[0].reason, /does not accept call_type review/);
});

test("an unknown expect key is a failure, not a silent skip", () => {
  const suite = withSuite(
    { schema_version: 1, cases: [
      { id: "x", kind: "positive", call_type: "delegate", expect: { madeUp: 1 } },
    ] },
    (r) => loadEvalSuite(MANIFEST, r)
  );
  const report = runEvalSuite({ manifest: MANIFEST, suite, specialistId: MANIFEST.id });
  assert.equal(report.results[0].outcome, "fail");
});
