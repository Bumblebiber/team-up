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

test("a named unit rides along so telemetry can find the worker's cgroup", async () => {
  const { sandboxUnitName } = await import("../../src/sandbox/systemd.mjs");
  const unit = sandboxUnitName("20261001T101500Z-ab12", 1_700_000_000_000);
  assert.equal(unit, `team-up-20261001T101500Z-ab12-${(1_700_000_000_000).toString(36)}`);
  const wrapped = wrapWithSandbox({
    command: ["/bin/echo", "hi"],
    permissions: { writes: false },
    cwd: "/tmp",
    probe: () => true,
    unit,
  });
  assert.ok(wrapped.argv.includes(`--unit=${unit}`));
  assert.ok(wrapped.argv.indexOf(`--unit=${unit}`) < wrapped.argv.indexOf("--"));
  assert.equal(wrapped.unit, `${unit}.service`);

  const plain = systemdSandboxArgv({ cwd: "/tmp", command: ["echo"] });
  assert.ok(!plain.some((a) => String(a).startsWith("--unit")));
  assert.throws(() => systemdSandboxArgv({ cwd: "/tmp", command: ["echo"], unit: "bad name;rm" }), /invalid systemd unit name/);
});

test("memory ceilings become MemoryHigh/MemoryMax only under systemd-run, and say whether they hold", () => {
  const base = { command: ["/usr/bin/echo"], permissions: { writes: false }, cwd: "/tmp", probe: () => true, enforcement: "best_effort" };
  const plain = wrapWithSandbox(base);
  assert.ok(!plain.argv.some((a) => String(a).startsWith("Memory")));
  assert.equal("memory_max_applied" in plain, false);

  const capped = wrapWithSandbox({ ...base, memoryLimits: { high_kb: 1536, max_kb: 2048 } });
  const dash = capped.argv.indexOf("--");
  assert.ok(capped.argv.indexOf("MemoryHigh=1536K") < dash);
  assert.ok(capped.argv.indexOf("MemoryMax=2048K") < dash);
  assert.equal(capped.memory_max_applied, true);

  const fallback = wrapWithSandbox({ ...base, probe: () => false, memoryLimits: { high_kb: 1536, max_kb: 2048 } });
  assert.equal(fallback.sandbox, "none");
  assert.equal(fallback.memory_max_applied, false);
  const noIsolation = wrapWithSandbox({ ...base, permissions: {}, memoryLimits: { high_kb: 1, max_kb: 2 } });
  assert.equal(noIsolation.memory_max_applied, false);
});
