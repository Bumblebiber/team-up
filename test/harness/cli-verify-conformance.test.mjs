import test from "node:test";
import assert from "node:assert/strict";
import {
  ISOLATION_CANARIES,
  validateIsolationObservation,
} from "../../src/harness/cli-verify.mjs";

/**
 * Conformance unit: Claude returning without calling MCP must not verify.
 * Exercises the decision logic used by liveClaudeVerifyRunner without paid calls.
 */
test("Claude response without MCP call cannot set broker_tool=passed", async () => {
  const { decideBrokerToolFromEvidence } = await import(
    "../../src/harness/cli-verify.mjs"
  );

  assert.equal(
    decideBrokerToolFromEvidence({
      stdout: "I cannot call that tool",
      freshAudit: false,
      auditOk: false,
    }),
    "unverified"
  );
  assert.equal(
    decideBrokerToolFromEvidence({
      stdout: "ok",
      freshAudit: false,
      auditOk: false,
    }),
    "unverified"
  );
  assert.equal(
    decideBrokerToolFromEvidence({
      stdout: "explanation\nok",
      freshAudit: true,
      auditOk: true,
    }),
    "unverified"
  );
  assert.equal(
    decideBrokerToolFromEvidence({
      stdout: "ok\nextra",
      freshAudit: true,
      auditOk: true,
    }),
    "unverified"
  );
  assert.equal(
    decideBrokerToolFromEvidence({
      stdout: "ok",
      freshAudit: true,
      auditOk: true,
    }),
    "passed"
  );
});

test("direct MCP preflight alone is insufficient for verification record", async () => {
  const { verifyHarness } = await import("../../src/harness/verify.mjs");
  const { claudeAdapter } = await import("../../src/harness/claude.mjs");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-verify-preflight-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  const record = await verifyHarness({
    adapter: claudeAdapter,
    fixtureProject: "/tmp",
    env,
    runner: Object.assign(
      async () => ({
        native_shell: "denied",
        // Preflight ok but Claude never proved the tool:
        broker_preflight: "ok",
        broker_tool: "failed",
      }),
      { execFileSync: () => "claude 9.9.9\n" }
    ),
  });
  assert.equal(record.status, "failed");
  assert.equal(record.broker_tool, "failed");
  fs.rmSync(home, { recursive: true, force: true });
});

test("isolation observation passes only on an exact match with all canaries absent", () => {
  const expected = {
    skills: ["capsule.selected-skill"],
    plugins: ["capsule.selected-plugin"],
    mcp_tools: ["mcp__selected__lookup"],
    frameworks: ["capsule.selected-framework"],
  };
  const observed = {
    ...expected,
    absent: [...ISOLATION_CANARIES],
  };
  assert.deepEqual(validateIsolationObservation({ expected, observed }), {
    ok: true,
    errors: [],
  });
});

test("every visible canary fails isolation verification", () => {
  const expected = {
    skills: ["capsule.selected-skill"],
    plugins: [],
    mcp_tools: [],
    frameworks: [],
  };
  for (const leaked of ISOLATION_CANARIES) {
    const observed = {
      ...expected,
      absent: ISOLATION_CANARIES.filter((name) => name !== leaked),
    };
    const result = validateIsolationObservation({ expected, observed });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), new RegExp(`forbidden capability visible: ${leaked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
});

test("an extra or missing MCP tool fails isolation verification", () => {
  const expected = { skills: [], plugins: [], mcp_tools: ["mcp__selected__lookup"], frameworks: [] };
  const extra = validateIsolationObservation({
    expected,
    observed: {
      ...expected,
      mcp_tools: ["mcp__selected__lookup", "mcp__other__tool"],
      absent: [...ISOLATION_CANARIES],
    },
  });
  assert.equal(extra.ok, false);
  assert.match(extra.errors.join("\n"), /mcp_tools mismatch/);

  const missing = validateIsolationObservation({
    expected,
    observed: { ...expected, mcp_tools: [], absent: [...ISOLATION_CANARIES] },
  });
  assert.equal(missing.ok, false);
});

test("an absent report is a failure, not a pass", () => {
  const result = validateIsolationObservation({
    expected: { skills: ["capsule.selected-skill"] },
    observed: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1 + ISOLATION_CANARIES.length);
});
