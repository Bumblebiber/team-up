import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateNativeShellFromStream,
  parseClaudeStreamEvents,
  decideBrokerToolFromEvidence,
} from "../../src/harness/cli-verify.mjs";

test("Claude prose denial sentinel without stream evidence stays unverified", () => {
  const prose =
    "Bash is unavailable or denied by policy. NATIVE_SHELL_DENIED. I will not invent tools.";
  const events = parseClaudeStreamEvents(prose);
  assert.equal(events.length, 0);
  assert.equal(
    evaluateNativeShellFromStream({ events, text: prose }),
    "unverified"
  );
});

test("broker output with surrounding prose is unverified; exact trimmed ok + audit passes", () => {
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
  assert.equal(
    decideBrokerToolFromEvidence({
      stdout: "  ok\n",
      freshAudit: true,
      auditOk: true,
    }),
    "passed"
  );
  assert.equal(
    decideBrokerToolFromEvidence({
      stdout: "ok",
      freshAudit: false,
      auditOk: true,
    }),
    "unverified"
  );
});

test("structured Bash rejection with is_error/error classifies denied; prose stays unverified", () => {
  const stream = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_bash1",
            name: "Bash",
            input: { command: "echo hi" },
            is_error: true,
            error: "Bash tool is disallowed by policy",
          },
        ],
      },
    }),
  ].join("\n");
  const events = parseClaudeStreamEvents(stream);
  assert.ok(
    events.some((e) => e.type === "tool_use" && e.name === "Bash" && e.is_error === true),
    `expected is_error preserved on tool_use, got ${JSON.stringify(events)}`
  );
  assert.ok(
    events.some((e) => e.error && /disallowed/i.test(String(e.error))),
    `expected error preserved on tool_use, got ${JSON.stringify(events)}`
  );
  assert.equal(evaluateNativeShellFromStream({ events, text: stream }), "denied");

  const prose =
    "Bash is unavailable or denied by policy. NATIVE_SHELL_DENIED. I will not invent tools.";
  assert.equal(
    evaluateNativeShellFromStream({
      events: parseClaudeStreamEvents(prose),
      text: prose,
    }),
    "unverified"
  );
});
