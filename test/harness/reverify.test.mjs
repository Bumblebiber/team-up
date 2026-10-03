import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reverifyAllDrifted, reverifyDrifted, REVERIFY_COOLDOWN_MS } from "../../src/harness/reverify.mjs";
import { verificationAttemptPath } from "../../src/harness/verify.mjs";
import { harnessStatus } from "../../src/harness/registry.mjs";
import { ISOLATION_FORBIDDEN_CANARIES } from "../../src/harness/isolation-canary.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";

/**
 * Drift is repaired, but never more than once per build: a verify that throws
 * writes no record, so without the attempt marker a logged-out host would pay
 * for a real CLI run on every cron tick and every launch.
 */
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-reverify-"));
  try {
    return await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function plant(home, adapter, version, status = "verified") {
  const dir = path.join(home, "harness-verification", adapter);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${version}.json`),
    JSON.stringify({ adapter, cli_version: version, status, checked_at: "2026-09-01T09:00:00.000Z" })
  );
}

const versionStub = (v) => () => v;

/** A verify runner that plants the record a real one would write. */
function planting(home, version, status = "verified") {
  const runner = async () => {
    runner.calls += 1;
    plant(home, "claude", version, status);
    return status === "verified" ? 0 : 2;
  };
  runner.calls = 0;
  return runner;
}

test("drift is re-verified once and the grant comes back", async () => {
  await withHome(async (home) => {
    plant(home, "claude", "2.1.252");
    const verify = planting(home, "2.1.284");
    const r = await reverifyDrifted("claude", {
      env: { TEAM_UP_HOME: home },
      execFileSync: versionStub("2.1.284 (Claude Code)\n"),
      verify,
    });
    assert.equal(r.attempted, true);
    assert.equal(r.status, "verified");
    assert.equal(r.from_version, "2.1.252");
    assert.equal(verify.calls, 1);
  });
});

test("a verified, failed or record-less adapter is left alone", async () => {
  await withHome(async (home) => {
    const env = { TEAM_UP_HOME: home };
    const verify = async () => assert.fail("must not verify");
    assert.equal(
      (await reverifyDrifted("claude", { env, execFileSync: versionStub("2.1.284"), verify })).status,
      "no_record"
    );
    plant(home, "claude", "2.1.284", "failed");
    assert.equal(
      (await reverifyDrifted("claude", { env, execFileSync: versionStub("2.1.284"), verify })).status,
      "failed"
    );
    plant(home, "claude", "2.1.284", "verified");
    assert.equal(
      (await reverifyDrifted("claude", { env, execFileSync: versionStub("2.1.284"), verify })).status,
      "verified"
    );
  });
});

test("a throwing verify is not retried before the cooldown", async () => {
  await withHome(async (home) => {
    plant(home, "claude", "2.1.252");
    const env = { TEAM_UP_HOME: home };
    let calls = 0;
    const blowUp = async () => {
      calls += 1;
      throw new Error("BLOCKED: not logged in");
    };
    await assert.rejects(() => reverifyDrifted("claude", {
      env, execFileSync: versionStub("2.1.284"), verify: blowUp,
    }), /not logged in/);
    // No record was written, so the host is still drifted — and must not pay again.
    const second = await reverifyDrifted("claude", {
      env, execFileSync: versionStub("2.1.284"), verify: blowUp,
    });
    assert.equal(calls, 1);
    assert.equal(second.attempted, false);
    assert.equal(second.reason, "cooling");
    // Past the cooldown it tries once more.
    const marker = verificationAttemptPath("claude", "2.1.284", env);
    const third = await reverifyDrifted("claude", {
      env,
      execFileSync: versionStub("2.1.284"),
      verify: planting(home, "2.1.284"),
      now: () => Date.now() + REVERIFY_COOLDOWN_MS + 1000,
    });
    assert.ok(fs.existsSync(marker));
    assert.equal(third.attempted, true);
    assert.equal(third.status, "verified");
  });
});

test("a fan-out pays for one verification, and the losers wait for it", async () => {
  await withHome(async (home) => {
    plant(home, "claude", "2.1.252");
    const env = { TEAM_UP_HOME: home };
    let started = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const slowVerify = async () => {
      started += 1;
      await gate;
      plant(home, "claude", "2.1.284");
      return 0;
    };
    const winner = reverifyDrifted("claude", {
      env, execFileSync: versionStub("2.1.284"), verify: slowVerify,
    });
    const loser = reverifyDrifted("claude", {
      env,
      execFileSync: versionStub("2.1.284"),
      verify: async () => assert.fail("second verification must not start"),
      wait: true,
      pollMs: 1,
      sleep: async () => { release(); },
    });
    const [w, l] = await Promise.all([winner, loser]);
    assert.equal(started, 1);
    assert.equal(w.attempted, true);
    assert.equal(l.attempted, false);
    assert.equal(l.reason, "verified_elsewhere");
    assert.equal(l.status, "verified");
  });
});

test("a CLI without a live runner is reported, not re-verified", async () => {
  await withHome(async (home) => {
    plant(home, "opencode", "1.18.0");
    const r = await reverifyDrifted("opencode", {
      env: { TEAM_UP_HOME: home },
      execFileSync: versionStub("1.18.32"),
      verify: async () => assert.fail("no runner exists for opencode"),
    });
    assert.equal(r.attempted, false);
    assert.equal(r.status, "drifted");
    assert.equal(r.reason, "unsupported");
  });
});

test("the sweep skips an adapter that was never verified", async () => {
  await withHome(async (home) => {
    // codex has a live runner but no record at all; only claude may be verified.
    plant(home, "claude", "2.1.252");
    const verified = [];
    const results = await reverifyAllDrifted({
      env: { TEAM_UP_HOME: home },
      execFileSync: versionStub("2.1.284"),
      verify: async ([cli]) => {
        verified.push(cli);
        plant(home, cli, "2.1.284");
        return 0;
      },
    });
    assert.deepEqual(verified, ["claude"]);
    assert.deepEqual(results.map((r) => r.cli), ["claude"]);
  });
});

test("a pass proven against an older canary set is re-verified on the same build", async () => {
  await withHome(async (home) => {
    const env = { TEAM_UP_HOME: home };
    // What every record before the ancestor canaries carries: a grant, and an
    // absent list harnessCapabilities no longer accepts as its proof.
    const record = (absent) => {
      const dir = path.join(home, "harness-verification", "claude");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "2.1.286.json"), JSON.stringify({
        adapter: "claude",
        cli_version: "2.1.286",
        status: "verified",
        checked_at: "2026-10-03T11:00:44.015Z",
        context_isolation: CONTEXT_ISOLATION_CAPABILITY,
        context_isolation_absent: absent,
      }));
    };
    record(ISOLATION_FORBIDDEN_CANARIES.filter((name) => !name.startsWith("ancestor.")));
    const exec = versionStub("2.1.286 (Claude Code)\n");
    const stale = harnessStatus("claude", { env, execFileSync: exec });
    assert.equal(stale.status, "drifted");
    assert.equal(stale.stale_proof, true);
    let calls = 0;
    const r = await reverifyDrifted("claude", {
      env,
      execFileSync: exec,
      verify: async () => {
        calls += 1;
        record([...ISOLATION_FORBIDDEN_CANARIES]);
        return 0;
      },
    });
    assert.equal(calls, 1);
    assert.equal(r.attempted, true);
    assert.equal(r.status, "verified");
    assert.equal(harnessStatus("claude", { env, execFileSync: exec }).stale_proof, undefined);
  });
});
