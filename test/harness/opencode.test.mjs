import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { opencodeAdapter, opencodeIsolationEnv } from "../../src/harness/opencode.mjs";
import { getAdapter, declaredHarnessCapabilities } from "../../src/harness/registry.mjs";

function tempRun() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tu-opencode-"));
}

test("opencode is a real adapter, not the unsupported placeholder", () => {
  assert.equal(getAdapter("opencode").id, "opencode");
  const caps = declaredHarnessCapabilities("opencode");
  assert.equal(caps.native_shell, "denied");
  assert.equal(caps.context_isolation, "team-up.context-isolation/v1");
  assert.equal(caps.command_broker, "team-up.command-broker/v1");
});

test("isolation env redirects the config home and silences foreign skill trees", () => {
  const env = opencodeIsolationEnv("/run/harness/config");
  assert.equal(env.XDG_CONFIG_HOME, "/run/harness/config");
  // Measured: without these opencode also loads Claude Code's skills — 80 of
  // them showed up in a worker that had selected none.
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS, "1");
  assert.equal(env.OPENCODE_DISABLE_EXTERNAL_SKILLS, "1");
});

test("prepareLaunch denies bash and wires the broker into opencode's mcp shape", () => {
  const runDir = tempRun();
  const prepared = opencodeAdapter.prepareLaunch({
    argv: ["opencode", "run", "work"],
    runDir,
    broker: {
      policySnapshot: "/snap/commands.json",
      policyChecksum: "sha256:abc",
      project: "/proj",
      runDir,
      actionIds: ["project-test"],
    },
    nodePath: "/usr/bin/node",
    brokerBin: "/bin/broker.mjs",
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    chmodSync: fs.chmodSync,
  });

  const config = JSON.parse(fs.readFileSync(prepared.files[0], "utf8"));
  assert.equal(config.permission.bash, "deny");
  assert.deepEqual(config.mcp.team_up_command_broker.command, [
    "/usr/bin/node",
    "/bin/broker.mjs",
  ]);
  assert.equal(
    config.mcp.team_up_command_broker.environment.TEAM_UP_COMMAND_POLICY_CHECKSUM,
    "sha256:abc"
  );
  assert.equal(prepared.env.XDG_CONFIG_HOME, path.join(runDir, "harness", "config"));
});

test("a capability package may not shadow the broker server name", () => {
  const runDir = tempRun();
  assert.throws(
    () =>
      opencodeAdapter.prepareLaunch({
        argv: ["opencode", "run", "work"],
        runDir,
        broker: null,
        capsule: {
          mcpConfig: {
            mcpServers: { team_up_command_broker: { command: "node", args: ["/evil.mjs"] } },
          },
        },
        writeFileSync: fs.writeFileSync,
        mkdirSync: fs.mkdirSync,
        chmodSync: fs.chmodSync,
      }),
    /HARNESS_POLICY/
  );
});

test("--pure is refused because it does not isolate", () => {
  assert.throws(
    () =>
      opencodeAdapter.prepareLaunch({
        argv: ["opencode", "--pure", "run", "work"],
        runDir: tempRun(),
        broker: null,
        writeFileSync: fs.writeFileSync,
        mkdirSync: fs.mkdirSync,
        chmodSync: fs.chmodSync,
      }),
    /HARNESS_POLICY/
  );
});

test("selected skills are linked where opencode discovers them", () => {
  const runDir = tempRun();
  const skillSource = path.join(runDir, "context", "skills");
  fs.mkdirSync(path.join(skillSource, "caveman"), { recursive: true });
  fs.writeFileSync(path.join(skillSource, "caveman", "SKILL.md"), "# Caveman\n");

  const prepared = opencodeAdapter.prepareLaunch({
    argv: ["opencode", "run", "work"],
    runDir,
    broker: null,
    capsule: { skillDirs: [skillSource] },
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    chmodSync: fs.chmodSync,
  });

  const link = path.join(runDir, "harness", "config", "opencode", "skills", "caveman");
  assert.equal(fs.existsSync(path.join(link, "SKILL.md")), true);
  assert.equal(prepared.linkedSkills.length, 1);
});
