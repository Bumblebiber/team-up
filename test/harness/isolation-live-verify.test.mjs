import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAdapter } from "../../src/harness/claude.mjs";
import { codexAdapter } from "../../src/harness/codex.mjs";
import { verifyHarness } from "../../src/harness/verify.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";
import {
  buildIsolationCanaryFixture,
  collectLaunchIsolationObservation,
  decideContextIsolationCapability,
  parseIsolationObservationJson,
} from "../../src/harness/isolation-canary.mjs";

test("canary fixture exposes selected set and keeps forbidden canaries out of capsule", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    assert.deepEqual(fixture.expected, {
      skills: ["capsule.selected-skill"],
      plugins: ["capsule.selected-plugin"],
      mcp_tools: ["mcp__selected__lookup"],
      frameworks: ["capsule.selected-framework"],
    });
    assert.equal(
      fs.existsSync(path.join(fixture.globalHome, ".claude", "skills", "global.canary-skill", "SKILL.md")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(fixture.runRoot, "context", "skills", "capsule.selected-skill")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(fixture.runRoot, "context", "skills", "pool.unselected-skill")),
      false
    );
    assert.equal(
      fs.existsSync(path.join(fixture.runRoot, "harness", "mcp", "excluded")),
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test("exact Claude launch observation grants isolation capability token", () => {
  const fixture = buildIsolationCanaryFixture();
  const writes = new Map();
  try {
    const prepared = claudeAdapter.prepareLaunch({
      argv: ["claude", "--print", "probe"],
      runDir: fixture.runRoot,
      capsule: fixture.capsule,
      writeFileSync: (file, text) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        writes.set(file, text);
      },
      mkdirSync: (dir, opts) => fs.mkdirSync(dir, opts),
      chmodSync: () => {},
    });
    const observed = collectLaunchIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      adapterId: "claude",
    });
    assert.ok(observed);
    assert.equal(
      decideContextIsolationCapability({ expected: fixture.expected, observed }),
      CONTEXT_ISOLATION_CAPABILITY
    );
  } finally {
    fixture.cleanup();
  }
});

test("malformed skipped or partial observation withholds isolation token", () => {
  const expected = {
    skills: ["capsule.selected-skill"],
    plugins: ["capsule.selected-plugin"],
    mcp_tools: ["mcp__selected__lookup"],
    frameworks: ["capsule.selected-framework"],
  };
  assert.equal(decideContextIsolationCapability({ expected, observed: null }), null);
  assert.equal(parseIsolationObservationJson("not-json"), null);
  assert.equal(parseIsolationObservationJson("{"), null);
  assert.equal(
    decideContextIsolationCapability({
      expected,
      observed: parseIsolationObservationJson(JSON.stringify({
        skills: ["capsule.selected-skill"],
        // missing plugins/mcp_tools/frameworks/absent
      })),
    }),
    null
  );
  assert.equal(
    decideContextIsolationCapability({
      expected,
      observed: {
        skills: ["capsule.selected-skill"],
        plugins: ["capsule.selected-plugin"],
        mcp_tools: ["mcp__selected__lookup"],
        frameworks: ["capsule.selected-framework"],
        absent: ["global.canary-skill"], // partial absences
      },
    }),
    null
  );
});

test("verifyHarness stores context_isolation only on exact runner token", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-iso-verify-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  try {
    const brokerOnly = await verifyHarness({
      adapter: claudeAdapter,
      fixtureProject: "/tmp",
      env,
      runner: Object.assign(
        async () => ({
          native_shell: "denied",
          broker_tool: "passed",
        }),
        { execFileSync: () => "claude 3.3.3\n" }
      ),
    });
    assert.equal(brokerOnly.status, "verified");
    assert.equal(brokerOnly.context_isolation, null);

    const withIsolation = await verifyHarness({
      adapter: {
        ...claudeAdapter,
        version: () => "3.3.4",
      },
      fixtureProject: "/tmp",
      env,
      runner: Object.assign(
        async () => ({
          native_shell: "denied",
          broker_tool: "passed",
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
        }),
        { execFileSync: () => "3.3.4" }
      ),
    });
    assert.equal(withIsolation.status, "verified");
    assert.equal(withIsolation.context_isolation, CONTEXT_ISOLATION_CAPABILITY);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Codex launch observation grants isolation when capsule matches", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = codexAdapter.prepareLaunch({
      argv: ["codex", "exec", "probe"],
      runDir: fixture.runRoot,
      capsule: fixture.capsule,
      authSource: null,
    });
    const observed = collectLaunchIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      adapterId: "codex",
    });
    assert.ok(observed);
    assert.equal(
      decideContextIsolationCapability({
        expected: fixture.codexExpected,
        observed,
      }),
      CONTEXT_ISOLATION_CAPABILITY
    );
    assert.equal(prepared.env.CODEX_HOME, fixture.capsule.codexHome);
    assert.equal(
      fs.existsSync(path.join(fixture.capsule.codexHome, "skills", "global.canary-skill")),
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test("verifyHarness codex path verifies from isolation without broker", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-codex-verify-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  try {
    const unverified = await verifyHarness({
      adapter: codexAdapter,
      fixtureProject: "/tmp",
      env,
      runner: Object.assign(
        async () => ({
          native_shell: "unverified",
          broker_tool: "unverified",
          isolation_status: "unverified",
          error: "codex auth unavailable",
        }),
        { execFileSync: () => "codex-cli 0.145.0\n" }
      ),
    });
    assert.equal(unverified.status, "unverified");
    assert.equal(unverified.context_isolation, null);
    assert.equal(unverified.command_broker, null);

    const verified = await verifyHarness({
      adapter: {
        ...codexAdapter,
        version: () => "0.145.1",
      },
      fixtureProject: "/tmp",
      env,
      runner: Object.assign(
        async () => ({
          native_shell: "unverified",
          broker_tool: "unverified",
          isolation_status: "passed",
          context_isolation: CONTEXT_ISOLATION_CAPABILITY,
        }),
        { execFileSync: () => "0.145.1" }
      ),
    });
    assert.equal(verified.status, "verified");
    assert.equal(verified.context_isolation, CONTEXT_ISOLATION_CAPABILITY);
    assert.equal(verified.command_broker, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runHarnessVerify codex never reports adapter not ready", async () => {
  const { runHarnessVerify } = await import("../../src/harness/cli-verify.mjs");
  const fixtureProject = fs.mkdtempSync(path.join(os.tmpdir(), "tu-codex-cli-"));
  const err = [];
  const out = [];
  const code = await runHarnessVerify(
    ["codex", "--fixture-project", fixtureProject],
    {
      out: (line) => out.push(String(line)),
      err: (line) => err.push(String(line)),
      runners: {
        codex: Object.assign(
          async () => ({
            native_shell: "unverified",
            broker_tool: "unverified",
            isolation_status: "unverified",
            error: "codex executable unavailable in test",
          }),
          { execFileSync: () => "codex-cli 0.145.0\n" }
        ),
      },
      env: { ...process.env, TEAM_UP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-")) },
    }
  );
  fs.rmSync(fixtureProject, { recursive: true, force: true });
  assert.notEqual(code, 1);
  assert.equal(err.some((e) => /not ready/i.test(e)), false);
  assert.equal(out.some((l) => /status:\s*unverified/.test(l)), true);
});
