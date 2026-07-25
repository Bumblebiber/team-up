import test from "node:test";
import assert from "node:assert/strict";
import { systemdSandboxArgv, wrapWithSandbox } from "../../src/sandbox/systemd.mjs";

test("systemdSandboxArgv builds fail-closed argv", () => {
  const argv = systemdSandboxArgv({
    cwd: "/tmp/work",
    network: false,
    writablePaths: ["/tmp/work"],
    command: ["echo", "hi"],
  });
  assert.equal(argv[0], "systemd-run");
  assert.ok(argv.includes("PrivateNetwork=yes"));
  assert.ok(argv.includes("ProtectSystem=strict"));
  assert.ok(argv.includes("ProtectHome=tmpfs"));
});

test("wrapWithSandbox refuses when unavailable", () => {
  assert.throws(
    () => wrapWithSandbox({
      command: ["echo"],
      permissions: { network: false },
      cwd: "/tmp",
      probe: () => false,
    }),
    /SANDBOX_UNAVAILABLE/
  );
});
