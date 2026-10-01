import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync as realExecFileSync } from "node:child_process";
import { pinVerifiedBinary, pinnedBinaryPath } from "../../src/harness/binary.mjs";
import { effectiveHarnessBinary, harnessCapabilities, harnessStatus } from "../../src/harness/registry.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";

/**
 * A claude update the canary cannot clear yet must leave specialists on the
 * last verified build, not unlaunchable — and only on a build that really is
 * the one its record verified.
 */
function fakeClaude(dir, version) {
  const bin = path.join(dir, `claude-${version}`);
  fs.writeFileSync(bin, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
  return bin;
}

function plant(home, version, status) {
  const dir = path.join(home, "harness-verification", "claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${version}.json`), JSON.stringify({
    adapter: "claude",
    cli_version: version,
    status,
    checked_at: `2026-10-0${status === "verified" ? 1 : 2}T00:00:00.000Z`,
    command_broker: status === "verified" ? "team-up.command-broker/v1" : null,
    context_isolation: status === "verified" ? CONTEXT_ISOLATION_CAPABILITY : null,
  }));
}

/** `claude` on PATH resolves to `installed`; every other binary really runs. */
const execAs = (installed) => (bin, args, opts) => {
  if (bin === "which") return `${installed}\n`;
  return realExecFileSync(bin === "claude" ? installed : bin, args, opts);
};

test("an unverified update falls back to the pinned verified build, and only to a genuine one", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pin-"));
  try {
    const env = { TEAM_UP_HOME: home };
    const old = fakeClaude(home, "2.1.285");
    const next = fakeClaude(home, "2.1.286");

    // The verify that passed on 2.1.285 pins exactly that build…
    plant(home, "2.1.285", "verified");
    const pinned = pinVerifiedBinary("claude", "2.1.285", { env, execFileSync: execAs(old) });
    assert.equal(pinned, pinnedBinaryPath("claude", "2.1.285", env));
    assert.equal(fs.statSync(pinned).ino, fs.statSync(old).ino, "hardlink, not a copy");
    // …and refuses to pin when PATH already moved on to another build.
    assert.equal(pinVerifiedBinary("claude", "2.1.284", { env, execFileSync: execAs(next) }), null);

    // 2.1.286 installs and fails verification: launches run the pin.
    plant(home, "2.1.286", "unverified");
    const exec = execAs(next);
    assert.deepEqual(effectiveHarnessBinary("claude", { env, execFileSync: exec }),
      { bin: pinned, version: "2.1.285", fallback_from: "2.1.286" });
    assert.equal(harnessCapabilities("claude", { env, execFileSync: exec }).context_isolation,
      CONTEXT_ISOLATION_CAPABILITY);
    const status = harnessStatus("claude", { env, execFileSync: exec });
    assert.equal(status.status, "failed", "the installed build's verdict stays visible");
    assert.equal(status.fallback_version, "2.1.285");

    // A pin whose binary is not the build its name claims grants nothing.
    fs.rmSync(pinned);
    fs.copyFileSync(next, pinned);
    assert.deepEqual(effectiveHarnessBinary("claude", { env, execFileSync: exec }),
      { bin: "claude", version: "2.1.286" });
    assert.equal(harnessCapabilities("claude", { env, execFileSync: exec }).context_isolation, null);

    // Once the installed build verifies, it runs itself.
    plant(home, "2.1.286", "verified");
    assert.deepEqual(effectiveHarnessBinary("claude", { env, execFileSync: exec }),
      { bin: "claude", version: "2.1.286" });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
