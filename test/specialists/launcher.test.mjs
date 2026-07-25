import test from "node:test";
import assert from "node:assert/strict";
import { launch } from "../../src/specialists/launcher.mjs";
import { wrapWithSandbox } from "../../src/sandbox/systemd.mjs";

test("launcher refuses required sandbox when probe fails; missing specialist still errors", async () => {
  await assert.rejects(
    async () => {
      wrapWithSandbox({
        command: ["true"],
        permissions: { network: false },
        cwd: "/tmp",
        probe: () => false,
        enforcement: "required",
      });
    },
    /SANDBOX_UNAVAILABLE/
  );
  await assert.rejects(
    () =>
      launch({
        specialistId: "missing",
        callType: "review",
        objective: "x",
        project: "/tmp",
        sandbox: { probe: () => false },
        permissions: { network: false },
      }),
    /not installed/
  );
});
