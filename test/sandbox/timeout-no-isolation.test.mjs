import test from "node:test";
import assert from "node:assert/strict";
import { wrapWithSandbox } from "../../src/sandbox/systemd.mjs";

test("timeout wraps argv when no isolation flags are set", () => {
  const result = wrapWithSandbox({
    command: ["/usr/bin/echo", "hi"],
    permissions: {},
    cwd: "/tmp",
    timeoutSeconds: 17,
    probe: () => true,
  });
  assert.equal(result.sandbox, "none");
  assert.equal(result.argv[0], "timeout");
  assert.ok(result.argv.includes("17s"));
  assert.equal(result.timeout_enforced, true);
});
