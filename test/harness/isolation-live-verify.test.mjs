import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { claudeAdapter } from "../../src/harness/claude.mjs";
import { codexAdapter } from "../../src/harness/codex.mjs";
import { verifyHarness } from "../../src/harness/verify.mjs";
import { CONTEXT_ISOLATION_CAPABILITY } from "../../src/harness/capabilities.mjs";
import {
  buildIsolationCanaryFixture,
  collectLaunchIsolationObservation,
  collectLiveIsolationObservation,
  decideContextIsolationCapability,
  executeConfiguredMcpCanaryTool,
  parseIsolationObservationJson,
  observeContextIsolation,
  ISOLATION_FORBIDDEN_CANARIES,
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
    assert.equal(fixture.codexExpected, null);
    assert.equal(
      fs.existsSync(path.join(fixture.ambientProject, ".mcp.json")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(fixture.globalHome, ".mcp.json")),
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

test("selected MCP canary tool executes successfully", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const server = fixture.capsule.mcpConfig.mcpServers.selected;
    const result = executeConfiguredMcpCanaryTool(server, {
      spawnSyncFn: spawnSync,
      toolName: "lookup",
    });
    assert.ok(result);
    assert.equal(result.tool, "lookup");
  } finally {
    fixture.cleanup();
  }
});

test("launch-surface observation alone does not grant isolation without live probe", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = claudeAdapter.prepareLaunch({
      argv: ["claude", "--print", "probe"],
      runDir: fixture.runRoot,
      capsule: fixture.capsule,
      writeFileSync: (file, text) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      },
      mkdirSync: (dir, opts) => fs.mkdirSync(dir, opts),
      chmodSync: () => {},
    });
    const surface = collectLaunchIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      adapterId: "claude",
    });
    assert.ok(surface);
    const result = observeContextIsolation({
      adapter: claudeAdapter,
      adapterId: "claude",
      spawnSyncFn: null,
      liveProbe: null,
    });
    assert.equal(result.context_isolation, null);
    assert.match(result.error || "", /missing|skipped|malformed/i);
  } finally {
    fixture.cleanup();
  }
});

test("disk or config-only Claude observation does not grant isolation token", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = claudeAdapter.prepareLaunch({
      argv: ["claude", "--print", "probe"],
      runDir: fixture.runRoot,
      capsule: fixture.capsule,
      writeFileSync: (file, text) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      },
      mkdirSync: (dir, opts) => fs.mkdirSync(dir, opts),
      chmodSync: () => {},
    });
    // spawnSync that only answers plugin list — no mcp list control, no model turn
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      ambientProject: fixture.ambientProject,
      adapterId: "claude",
      spawnSyncFn: (cmd, args) => {
        const joined = [cmd, ...(args || [])].join(" ");
        if (joined.includes("plugin list")) {
          return {
            status: 0,
            stdout: "Session-only plugins\n❯ capsule.selected-plugin@local\n",
            stderr: "",
          };
        }
        // Deliberately fail mcp list / model turn
        return { status: 1, stdout: "", stderr: "skip" };
      },
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

test("exact live Claude observation grants isolation capability token", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = claudeAdapter.prepareLaunch({
      argv: ["claude", "--print", "probe"],
      runDir: fixture.runRoot,
      capsule: fixture.capsule,
      writeFileSync: (file, text) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      },
      mkdirSync: (dir, opts) => fs.mkdirSync(dir, opts),
      chmodSync: () => {},
    });
    const inventory = {
      skills: ["capsule.selected-skill"],
      plugins: ["capsule.selected-plugin"],
      mcp_tools: ["mcp__selected__lookup"],
      frameworks: ["capsule.selected-framework"],
      absent: [...ISOLATION_FORBIDDEN_CANARIES],
    };
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      ambientProject: fixture.ambientProject,
      adapterId: "claude",
      spawnSyncFn: (cmd, args, opts) => {
        const joined = [cmd, ...(args || [])].join(" ");
        // Real MCP canary tool execution uses node -e driver.
        if (joined.includes("-e") && String(args?.[0]) === "-e") {
          return spawnSync(cmd, args, opts);
        }
        if (joined.includes("mcp list")) {
          return {
            status: 0,
            stdout: "Checking MCP server health…\n\nglobal: node canary - ✔ Connected\n",
            stderr: "",
          };
        }
        if (joined.includes("plugin list")) {
          return {
            status: 0,
            stdout: "Session-only plugins\n❯ capsule.selected-plugin@local\n",
            stderr: "",
          };
        }
        if (joined.includes("--print") || joined.includes("isolation canary")) {
          return {
            status: 0,
            stdout: `${JSON.stringify(inventory)}\n`,
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected: ${joined}` };
      },
    });
    assert.ok(observed, "live observation should succeed with full harness probes");
    assert.equal(
      decideContextIsolationCapability({ expected: fixture.expected, observed }),
      CONTEXT_ISOLATION_CAPABILITY
    );
  } finally {
    fixture.cleanup();
  }
});

test("global MCP positive control requires claude mcp list visibility", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = claudeAdapter.prepareLaunch({
      argv: ["claude", "--print", "probe"],
      runDir: fixture.runRoot,
      capsule: fixture.capsule,
      writeFileSync: (file, text) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      },
      mkdirSync: (dir, opts) => fs.mkdirSync(dir, opts),
      chmodSync: () => {},
    });
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      ambientProject: fixture.ambientProject,
      adapterId: "claude",
      spawnSyncFn: (cmd, args, opts) => {
        const joined = [cmd, ...(args || [])].join(" ");
        if (joined.includes("-e") && String(args?.[0]) === "-e") {
          return spawnSync(cmd, args, opts);
        }
        if (joined.includes("mcp list")) {
          // Vacuous control: CLI sees nothing (old bug)
          return { status: 0, stdout: "No MCP servers configured\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(observed, null);
  } finally {
    fixture.cleanup();
  }
});

test("skipped live probe fails closed with null isolation token", () => {
  const result = observeContextIsolation({
    adapter: claudeAdapter,
    adapterId: "claude",
    spawnSyncFn: spawnSync,
    liveProbe: () => null,
  });
  assert.equal(result.context_isolation, null);
  assert.match(result.error || "", /skipped|incomplete/i);
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
        absent: ["global.canary-skill"],
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

test("Codex verify returns context_isolation null until full canary coverage", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = codexAdapter.prepareLaunch({
      argv: ["codex", "exec", "probe"],
      runDir: fixture.runRoot,
      capsule: fixture.capsule,
      authSource: null,
    });
    const observed = collectLiveIsolationObservation({
      prepared,
      capsule: fixture.capsule,
      globalHome: fixture.globalHome,
      adapterId: "codex",
      spawnSyncFn: spawnSync,
    });
    assert.equal(observed, null);
    assert.equal(codexAdapter.capabilities.context_isolation, null);
    const result = observeContextIsolation({
      adapter: codexAdapter,
      adapterId: "codex",
      spawnSyncFn: spawnSync,
    });
    assert.equal(result.context_isolation, null);
    assert.match(result.error || "", /incomplete|partial|null/i);
    assert.equal(prepared.env.CODEX_HOME, fixture.capsule.codexHome);
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

    // Even an injected token is stored only when runner returns it — live path
    // itself must not mint a partial Codex token.
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
          isolation_status: "unverified",
          context_isolation: null,
          error: "codex context isolation canary incomplete",
        }),
        { execFileSync: () => "0.145.1" }
      ),
    });
    assert.equal(verified.status, "unverified");
    assert.equal(verified.context_isolation, null);
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
