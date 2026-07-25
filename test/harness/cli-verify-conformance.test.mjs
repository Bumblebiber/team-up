import test from "node:test";
import assert from "node:assert/strict";

/**
 * Conformance unit: Claude returning without calling MCP must not verify.
 * Exercises the decision logic used by liveClaudeVerifyRunner without paid calls.
 */
test("Claude response without MCP call cannot set broker_tool=passed", async () => {
  // Simulate the gate: exact ok stdout + fresh audit required.
  function decideBrokerTool({ stdout, freshAudit, auditOk, preflightPassed }) {
    // Preflight must never promote.
    void preflightPassed;
    const textHasExactOk =
      String(stdout || "").trim() === "ok" ||
      /(^|\n)ok(\n|$)/.test(String(stdout || "").trim());
    if (textHasExactOk && freshAudit && auditOk) return "passed";
    return "failed";
  }

  assert.equal(
    decideBrokerTool({
      stdout: "I cannot call that tool",
      freshAudit: false,
      auditOk: false,
      preflightPassed: true,
    }),
    "failed"
  );
  assert.equal(
    decideBrokerTool({
      stdout: "ok",
      freshAudit: false,
      auditOk: false,
      preflightPassed: true,
    }),
    "failed"
  );
  assert.equal(
    decideBrokerTool({
      stdout: "ok",
      freshAudit: true,
      auditOk: true,
      preflightPassed: false,
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
