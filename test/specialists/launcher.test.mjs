import test from "node:test";
import assert from "node:assert/strict";
import { launch } from "../../src/specialists/launcher.mjs";
import { wrapWithSandbox } from "../../src/sandbox/systemd.mjs";

test("launcher refuses unsupported permission enforcement", async () => {
  await assert.rejects(
    async () => {
      // Match plan intent: fail closed when sandbox cannot enforce network=false
      wrapWithSandbox({
        command: ["true"],
        permissions: { network: false },
        cwd: "/tmp",
        probe: () => false,
      });
      // Also exercise launch early sandbox gate
      await launch({
        specialistId: "missing",
        callType: "review",
        objective: "x",
        project: "/tmp",
        sandbox: { available: false },
        permissions: { network: false },
      });
    },
    /SANDBOX_UNAVAILABLE|not installed/
  );
});
