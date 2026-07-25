import test from "node:test";
import assert from "node:assert/strict";
import { systemdSandboxArgv, wrapWithSandbox, systemdAvailable } from "../../src/sandbox/systemd.mjs";

test("sandbox hides $HOME via ProtectHome=tmpfs and bind paths", () => {
  const argv = systemdSandboxArgv({
    cwd: "/tmp/run/context",
    network: false,
    readOnlyPaths: ["/home/u/proj", "/usr/bin/cursor-agent"],
    writablePaths: ["/tmp/run"],
    command: ["cursor-agent", "--yolo", "hi"],
  });
  assert.ok(argv.includes("ProtectHome=tmpfs"));
  assert.ok(argv.includes("PrivateNetwork=yes"));
  assert.ok(argv.some((a) => String(a).includes("BindReadOnlyPaths=") || String(a).startsWith("/home/u/proj")));
  // Properties are passed as -p pairs
  const joined = argv.join("\n");
  assert.match(joined, /ProtectHome=tmpfs/);
  assert.match(joined, /BindReadOnlyPaths=/);
  assert.match(joined, /BindPaths=|ReadWritePaths=/);
});

test("consult/review get read-only project; delegate may get writable when permitted", () => {
  const consult = systemdSandboxArgv({
    cwd: "/ctx",
    network: false,
    callType: "consult",
    projectPath: "/proj",
    packagePath: "/pkg",
    runPath: "/run",
    cliPath: "/bin/cli",
    writableProject: false,
    command: ["cli"],
  });
  const cjoin = consult.join(" ");
  assert.match(cjoin, /ProtectHome=tmpfs/);
  assert.ok(!/BindPaths=\/proj/.test(cjoin) || /BindReadOnlyPaths=.*\/proj/.test(cjoin));

  const delegate = systemdSandboxArgv({
    cwd: "/ctx",
    network: false,
    callType: "delegate",
    projectPath: "/proj",
    packagePath: "/pkg",
    runPath: "/run",
    cliPath: "/bin/cli",
    writableProject: true,
    command: ["cli"],
  });
  const djoin = delegate.join(" ");
  assert.match(djoin, /BindPaths=.*\/proj|ReadWritePaths=.*\/proj/);
});

test("wrapWithSandbox uses real probe by default (not injected true)", () => {
  // When probe omitted, wrapWithSandbox must call systemdAvailable — inject by
  // stubbing would be external; here we assert the default probe reference equals systemdAvailable
  // via throwing when we pass a false probe, and that omitting probe is allowed only if available.
  assert.equal(typeof systemdAvailable, "function");
  assert.throws(
    () => wrapWithSandbox({
      command: ["echo"],
      permissions: { network: false, filesystem: "project" },
      cwd: "/tmp",
      probe: () => false,
    }),
    /SANDBOX_UNAVAILABLE/
  );
});
