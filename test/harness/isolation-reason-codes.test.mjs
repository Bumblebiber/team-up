import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAdapter } from "../../src/harness/claude.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";
import { diagnose } from "../../src/doctor.mjs";
import {
  buildIsolationCanaryFixture,
  decideContextIsolationCapability,
  ISOLATION_FORBIDDEN_CANARIES,
  parseClaudeStructuredCapabilityProofs,
  parseIsolationObservationJson,
} from "../../src/harness/isolation-canary.mjs";
import { isIsoFailure } from "../../src/harness/isolation-result.mjs";
import { assertIsoFailure } from "../helpers/isolation-assert.mjs";
import { loadVerificationRecord, verifyHarness } from "../../src/harness/verify.mjs";

test("parseIsolationObservationJson emits parse_json_failed for invalid text", () => {
  const result = parseIsolationObservationJson("not-json");
  assertIsoFailure(result, "parse_json_failed");
});

test("parseIsolationObservationJson grants unchanged observation shape on valid JSON", () => {
  const payload = {
    skills: ["capsule.selected-skill"],
    plugins: ["capsule.selected-plugin"],
    mcp_tools: ["mcp__selected__lookup"],
    frameworks: ["capsule.selected-framework"],
    absent: ["global.canary-skill"],
    content_nonces: { mcp: "nonce-1" },
  };
  const parsed = parseIsolationObservationJson(JSON.stringify(payload));
  assert.equal(isIsoFailure(parsed), false);
  assert.deepEqual(parsed.skills, payload.skills);
});

test("structured proof without tool pairs emits no_tool_pairs", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const stream = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-reason",
        tools: ["Skill", "mcp__selected__lookup"],
        skills: ["capsule.selected-skill"],
        plugins: ["capsule.selected-plugin"],
        mcp_servers: ["selected"],
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "sess-reason",
        message: { content: [{ type: "text", text: "no tools invoked" }] },
      }),
    ].join("\n");
    assertIsoFailure(
      parseClaudeStructuredCapabilityProofs(stream, {
        expected: fixture.expected,
        capsule: fixture.capsule,
      }),
      "no_tool_pairs"
    );
  } finally {
    fixture.cleanup();
  }
});

test("decideContextIsolationCapability still grants token on healthy observation", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const observed = {
      skills: fixture.expected.skills,
      plugins: fixture.expected.plugins,
      mcp_tools: fixture.expected.mcp_tools,
      frameworks: fixture.expected.frameworks,
      absent: [...ISOLATION_FORBIDDEN_CANARIES],
      content_nonces: { ...fixture.expected.nonces },
    };
    assert.equal(
      decideContextIsolationCapability({ expected: fixture.expected, observed }),
      CONTEXT_ISOLATION_CAPABILITY
    );
  } finally {
    fixture.cleanup();
  }
});

test("old verification record without reasons still loads", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-reason-old-record-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  const legacy = {
    adapter: "claude",
    cli_version: "1.0.0",
    checked_at: "2026-01-01T00:00:00Z",
    native_shell: "denied",
    broker_tool: "passed",
    command_broker: null,
    context_isolation: null,
    status: "unverified",
  };
  const dir = path.join(home, "harness-verification", "claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "1.0.0.json"), JSON.stringify(legacy));
  const loaded = loadVerificationRecord("claude", "1.0.0", env);
  assert.equal(loaded.status, "unverified");
  assert.equal(loaded.context_isolation_reason, undefined);
  fs.rmSync(home, { recursive: true, force: true });
});

test("verifyHarness stores per-capability reasons from runner checks", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-reason-record-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  const record = await verifyHarness({
    adapter: claudeAdapter,
    fixtureProject: "/tmp/fixture",
    env,
    runner: Object.assign(
      async () => ({
        native_shell: "denied",
        broker_tool: "passed",
        context_isolation: null,
        isolation_status: "unverified",
        context_isolation_reason: { code: "skill_proof_missing", detail: "capsule.selected-skill" },
      }),
      { execFileSync: () => "claude 3.3.3\n" }
    ),
  });
  assert.equal(record.status, "unverified");
  assert.equal(record.context_isolation_reason.code, "skill_proof_missing");
  assert.equal(record.command_broker_reason.code, "blocked_by_context_isolation");
  fs.rmSync(home, { recursive: true, force: true });
});

test("doctor finding carries harness verification reason", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-reason-doctor-"));
  try {
    const dir = path.join(home, "harness-verification", "claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "2.1.267.json"),
      JSON.stringify({
        adapter: "claude",
        cli_version: "2.1.267",
        checked_at: "2026-09-23T10:00:00.000Z",
        native_shell: "denied",
        broker_tool: "passed",
        command_broker: null,
        context_isolation: null,
        status: "unverified",
        context_isolation_reason: { code: "init_surface_exclusion", detail: "skill:design" },
        command_broker_reason: {
          code: "blocked_by_context_isolation",
          detail: "init_surface_exclusion",
        },
      })
    );
    const report = diagnose({ ...process.env, TEAM_UP_HOME: home }, {
      execFileSync: () => "2.1.267 (Claude Code)\n",
    });
    const finding = report.findings.find((f) => f.kind === "harness_verification_failed");
    assert.ok(finding);
    assert.equal(finding.context_isolation_reason, "init_surface_exclusion");
    assert.match(finding.detail, /init_surface_exclusion/);
    assert.match(finding.detail, /skill:design/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
