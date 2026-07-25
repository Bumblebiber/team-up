import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  systemdAvailable,
  resetSystemdAvailableCache,
  wrapWithSandbox,
} from "../../src/sandbox/systemd.mjs";

test("semantic probe caches only successful results", () => {
  resetSystemdAvailableCache();
  // First call runs live semantics. On hosts without real enforcement this is false
  // and must NOT be cached as success.
  const first = systemdAvailable();
  assert.equal(typeof first, "boolean");
  if (first === false) {
    // Force a second call; still false (no success cache poisoning).
    assert.equal(systemdAvailable(), false);
  } else {
    // Success path: second call must reuse cache without re-creating artifacts.
    assert.equal(systemdAvailable(), true);
  }
  resetSystemdAvailableCache();
});

test("semantic probe cleans up home sentinel artifacts", () => {
  resetSystemdAvailableCache();
  const before = new Set(
    fs.readdirSync(os.homedir()).filter((n) => n.startsWith(".team-up-sandbox-probe-"))
  );
  systemdAvailable();
  const after = fs.readdirSync(os.homedir()).filter((n) => n.startsWith(".team-up-sandbox-probe-"));
  for (const n of after) {
    assert.ok(before.has(n), `leaked probe dir: ${n}`);
  }
  resetSystemdAvailableCache();
});

test("live host: ineffective systemd semantics → SANDBOX_UNAVAILABLE (fail-closed)", () => {
  resetSystemdAvailableCache();
  const available = systemdAvailable();
  // Document host result: this Ubuntu user manager often accepts -p without enforcement.
  if (available) {
    // Rare: real enforcement works — wrap must succeed with injected paths that exist.
    const argv = wrapWithSandbox({
      command: ["/usr/bin/true"],
      permissions: { network: false, filesystem: "project_readonly" },
      cwd: "/tmp",
      projectPath: "/tmp",
      packagePath: "/tmp",
      runPath: "/tmp",
      cliPath: "/usr/bin/true",
      sandboxRuntimePaths: ["/usr/bin"],
      probe: systemdAvailable,
    });
    assert.equal(argv.sandbox, "systemd-run-user");
    return;
  }
  assert.throws(
    () =>
      wrapWithSandbox({
        command: ["/usr/bin/true"],
        permissions: { network: false, filesystem: "project_readonly" },
        cwd: "/tmp",
        projectPath: "/tmp",
        packagePath: "/tmp",
        runPath: "/tmp",
        cliPath: "/usr/bin/true",
        sandboxRuntimePaths: ["/usr/bin"],
        // omit probe → real systemdAvailable
      }),
    (e) => e.code === "SANDBOX_UNAVAILABLE" || /SANDBOX_UNAVAILABLE/.test(e.message)
  );
});

test("empty runtime_paths array is not configured for home CLI", () => {
  const homeCli = path.join(os.homedir(), ".local", "bin", "fake-home-cli-for-test");
  assert.throws(
    () =>
      wrapWithSandbox({
        command: [homeCli, "hi"],
        permissions: { network: false, filesystem: "project_readonly" },
        cwd: "/tmp/ctx",
        projectPath: "/tmp/proj",
        packagePath: "/tmp/pkg",
        runPath: "/tmp/run",
        cliPath: homeCli,
        sandboxRuntimePaths: [],
        requireHomeRuntime: true,
        probe: () => true,
      }),
    (e) => e.code === "SANDBOX_RUNTIME_UNAVAILABLE" || /SANDBOX_RUNTIME_UNAVAILABLE/.test(e.message)
  );
});
