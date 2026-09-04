import test from "node:test";
import assert from "node:assert/strict";
import { systemdSandboxArgv, wrapWithSandbox } from "../../src/sandbox/systemd.mjs";

test("systemdSandboxArgv builds fail-closed argv", () => {
  const argv = systemdSandboxArgv({
    cwd: "/tmp/work",
    writablePaths: ["/tmp/work"],
    command: ["echo", "hi"],
  });
  assert.equal(argv[0], "systemd-run");
  // The sandbox never touches the network: an agent that cannot reach its
  // provider API cannot start at all.
  assert.ok(!argv.some((a) => String(a).startsWith("PrivateNetwork")));
  assert.ok(argv.includes("ProtectSystem=strict"));
  assert.ok(argv.includes("ProtectHome=tmpfs"));
});

test("wrapWithSandbox refuses when unavailable", () => {
  assert.throws(
    () => wrapWithSandbox({
      command: ["echo"],
      permissions: { writes: false },
      cwd: "/tmp",
      probe: () => false,
    }),
    /SANDBOX_UNAVAILABLE/
  );
});

test("network: false alone needs no sandbox and keeps the network", () => {
  const wrapped = wrapWithSandbox({
    command: ["echo", "hi"],
    permissions: { network: false },
    cwd: "/tmp",
    probe: () => false,
  });
  assert.equal(wrapped.sandbox, "none");
  assert.ok(!wrapped.argv.some((a) => String(a).startsWith("PrivateNetwork")));
});

test("a sandboxed read-only specialist still gets the network", () => {
  const argv = systemdSandboxArgv({
    cwd: "/ctx",
    callType: "review",
    projectPath: "/proj",
    command: ["cli"],
  });
  assert.ok(!argv.some((a) => String(a).startsWith("PrivateNetwork")));
});

test("setenv rides into the transient unit, which starts with a clean environment", () => {
  const argv = wrapWithSandbox({
    command: ["claude"],
    permissions: { writes: false },
    cwd: "/tmp/work",
    probe: () => true,
    setenv: { TEAMUP_WORKER: "1", TEAMUP_RUN_ID: "r42", TEAMUP_EMPTY: undefined },
  }).argv;
  assert.ok(argv.includes("--setenv=TEAMUP_WORKER=1"));
  assert.ok(argv.includes("--setenv=TEAMUP_RUN_ID=r42"));
  assert.ok(!argv.some((a) => String(a).includes("TEAMUP_EMPTY")));
  assert.ok(argv.indexOf("--setenv=TEAMUP_WORKER=1") < argv.indexOf("--"));
});
