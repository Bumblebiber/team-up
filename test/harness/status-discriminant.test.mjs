import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { harnessStatus } from "../../src/harness/registry.mjs";

/** Verification health stays distinct from the adapter's launch capabilities. */
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-hstatus-"));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function plant(home, adapter, version, record) {
  const dir = path.join(home, "harness-verification", adapter);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${version}.json`), JSON.stringify(record));
}

/** A stub CLI that reports whatever version the test wants. */
function versionStub(version) {
  return () => version;
}

test("an adapter verified at the installed version is verified", () => {
  withHome((home) => {
    plant(home, "claude", "2.1.259", {
      adapter: "claude",
      cli_version: "2.1.259",
      status: "verified",
      checked_at: "2026-09-03T08:00:00.000Z",
    });
    const s = harnessStatus("claude", {
      env: { TEAM_UP_HOME: home },
      execFileSync: versionStub("2.1.259 (Claude Code)\n"),
    });
    assert.equal(s.status, "verified");
  });
});

test("a pass at another version and a newer CLI is drift, not absence", () => {
  withHome((home) => {
    plant(home, "claude", "2.1.252", {
      adapter: "claude",
      cli_version: "2.1.252",
      status: "verified",
      checked_at: "2026-09-01T09:57:52.333Z",
    });
    const s = harnessStatus("claude", {
      env: { TEAM_UP_HOME: home },
      execFileSync: versionStub("2.1.259 (Claude Code)\n"),
    });
    assert.equal(s.status, "drifted");
    assert.equal(s.last_verified_version, "2.1.252");
    assert.equal(s.installed_version, "2.1.259");
  });
});

test("no record at all is not drift", () => {
  withHome((home) => {
    const s = harnessStatus("claude", {
      env: { TEAM_UP_HOME: home },
      execFileSync: versionStub("2.1.259 (Claude Code)\n"),
    });
    assert.equal(s.status, "no_record");
  });
});

test("an older failed record does not describe the installed version", () => {
  withHome((home) => {
    plant(home, "claude", "2.1.252", {
      adapter: "claude",
      cli_version: "2.1.252",
      status: "verified",
      checked_at: "2026-07-01T00:00:00.000Z",
    });
    plant(home, "claude", "2.1.255", {
      adapter: "claude",
      cli_version: "2.1.255",
      status: "failed",
      checked_at: "2026-08-29T00:00:00.000Z",
    });
    const s = harnessStatus("claude", {
      env: { TEAM_UP_HOME: home },
      execFileSync: versionStub("2.1.259 (Claude Code)\n"),
    });
    assert.equal(s.status, "drifted");
  });
});

test("a failed record for the installed version is failed, not drift", () => {
  withHome((home) => {
    plant(home, "claude", "2.1.259", {
      adapter: "claude",
      cli_version: "2.1.259",
      status: "failed",
      checked_at: "2026-08-29T00:00:00.000Z",
    });
    const s = harnessStatus("claude", {
      env: { TEAM_UP_HOME: home },
      execFileSync: versionStub("2.1.259 (Claude Code)\n"),
    });
    assert.equal(s.status, "failed");
  });
});

test("a CLI with no adapter is unsupported, not merely unverified", () => {
  withHome((home) => {
    // cursor is installed and works; there is simply nothing to verify it
    // against. Reporting that as "no record" invites someone to go run a
    // verification that cannot exist.
    const s = harnessStatus("cursor", { env: { TEAM_UP_HOME: home } });
    assert.equal(s.status, "unsupported");
  });
});

test("a CLI that is not installed is not drift either", () => {
  withHome((home) => {
    plant(home, "claude", "2.1.252", {
      adapter: "claude",
      cli_version: "2.1.252",
      status: "verified",
      checked_at: "2026-09-01T09:57:52.333Z",
    });
    const s = harnessStatus("claude", {
      env: { TEAM_UP_HOME: home },
      execFileSync: () => {
        throw new Error("ENOENT");
      },
    });
    assert.equal(s.status, "not_installed");
  });
});
