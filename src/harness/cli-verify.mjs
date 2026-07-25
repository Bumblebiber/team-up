import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAdapter } from "./registry.mjs";
import { verifyHarness } from "./verify.mjs";
import { snapshotCommandPolicy } from "../commands/policy.mjs";
import { brokerBinPath } from "../commands/mcp-server.mjs";

function claudeLoginOrQuotaFailure(text) {
  const t = String(text || "").toLowerCase();
  return (
    /not logged in|please run .*login|authentication|unauthorized|quota|rate limit|credit|subscription/.test(
      t
    )
  );
}

/**
 * Live Claude conformance: invoke the installed CLI with the prepared MCP
 * broker config. Never infer denial from argv alone and never grant the
 * command-broker capability from flag inspection.
 */
export async function liveClaudeVerifyRunner({ adapter, fixtureProject, cliVersion }) {
  let versionOut = "";
  try {
    versionOut = execFileSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch (e) {
    return {
      native_shell: "unverified",
      broker_tool: "unverified",
      error: `claude executable unavailable: ${e.message}`,
    };
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-verify-home-"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-verify-run-"));
  const prevHome = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    const policy = {
      schema_version: 1,
      commands: {
        "project-test": {
          argv: [process.execPath, "-e", "process.stdout.write('ok')"],
          cwd: ".",
          timeout_seconds: 30,
          environment: {},
        },
      },
    };
    const snap = snapshotCommandPolicy({
      policy,
      runId: path.basename(runDir),
      workerVisibleDir: path.join(runDir, "policy"),
    });

    // Exercise the configured MCP broker via the same stdio server Claude would spawn.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [brokerBinPath()],
      env: {
        ...process.env,
        TEAM_UP_COMMAND_POLICY_SNAPSHOT: snap.path,
        TEAM_UP_COMMAND_POLICY_CHECKSUM: snap.checksum,
        TEAM_UP_PROJECT: path.resolve(fixtureProject),
        TEAM_UP_RUN_DIR: runDir,
      },
    });
    const client = new Client({ name: "team-up-verify", version: "0.0.0" });
    let broker_tool = "failed";
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      if (!names.includes("project_test")) {
        broker_tool = "failed";
      } else {
        const call = await client.callTool({ name: "project_test", arguments: {} });
        const body = call.content?.[0]?.text || "";
        const parsed = JSON.parse(body);
        broker_tool = parsed.exit_code === 0 && parsed.stdout === "ok" ? "passed" : "failed";
      }
    } catch (e) {
      broker_tool = "failed";
      if (claudeLoginOrQuotaFailure(e.message)) {
        return {
          native_shell: "unverified",
          broker_tool: "unverified",
          error: e.message,
          cli_version: cliVersion,
        };
      }
    } finally {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }

    function prepareWithPrompt(prompt) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-verify-harness-"));
      return adapter.prepareLaunch({
        argv: ["claude", "--print", "--output-format", "text", prompt],
        runDir: dir,
        broker: {
          policySnapshot: snap.path,
          policyChecksum: snap.checksum,
          project: path.resolve(fixtureProject),
          runDir,
          actionIds: ["project-test"],
        },
        brokerBin: brokerBinPath(),
        writeFileSync: fs.writeFileSync,
        mkdirSync: fs.mkdirSync,
        chmodSync: fs.chmodSync,
      });
    }

    // Real Claude invocation: ask it to run Bash. Denial must come from the live CLI.
    // Prompt must appear before adapter-appended flags.
    const shellProbePrompt =
      "Use the Bash tool to run the command: echo SHELL_SHOULD_BE_DENIED. " +
      "If Bash is unavailable, reply exactly with NATIVE_SHELL_DENIED. Do not invent success.";
    let shellPrepared;
    try {
      shellPrepared = prepareWithPrompt(shellProbePrompt);
    } catch (e) {
      return { native_shell: "unverified", broker_tool, error: e.message, cli_version: cliVersion };
    }
    const shellArgv = shellPrepared.argv;
    const shellRun = spawnSync(shellArgv[0], shellArgv.slice(1), {
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env },
      cwd: fixtureProject,
    });
    const shellText = `${shellRun.stdout || ""}\n${shellRun.stderr || ""}`;
    if (shellRun.error && /ENOENT/.test(String(shellRun.error))) {
      return {
        native_shell: "unverified",
        broker_tool: "unverified",
        error: `claude executable unavailable: ${shellRun.error.message}`,
      };
    }
    if (claudeLoginOrQuotaFailure(shellText) || (shellRun.status !== 0 && /login|auth|quota/i.test(shellText))) {
      return {
        native_shell: "unverified",
        broker_tool: broker_tool === "passed" ? "passed" : "unverified",
        error: shellText.trim().slice(0, 500) || "claude login/quota failure",
        cli_version: cliVersion,
      };
    }

    let native_shell = "allowed";
    if (
      /NATIVE_SHELL_DENIED/i.test(shellText) ||
      /bash.*(?:not allowed|disallowed|denied|unavailable)/i.test(shellText) ||
      /tool.*bash.*(?:not|denied|disallowed)/i.test(shellText) ||
      (/don't have a bash|do not have a bash|no bash tool/i.test(shellText))
    ) {
      native_shell = "denied";
    } else if (/SHELL_SHOULD_BE_DENIED/.test(shellText) && !/NATIVE_SHELL_DENIED/i.test(shellText)) {
      native_shell = "allowed";
    } else if (shellRun.status !== 0) {
      native_shell = "unverified";
    }

    if (native_shell === "denied" && broker_tool === "passed") {
      const brokerPrompt =
        "Call the MCP tool mcp__team_up_command_broker__project_test with no arguments. " +
        "Reply with the tool stdout only.";
      let brokerPrepared;
      try {
        brokerPrepared = prepareWithPrompt(brokerPrompt);
      } catch (e) {
        return { native_shell, broker_tool: "unverified", error: e.message, cli_version: cliVersion };
      }
      const brokerArgv = brokerPrepared.argv;
      const brokerRun = spawnSync(brokerArgv[0], brokerArgv.slice(1), {
        encoding: "utf8",
        timeout: 90_000,
        env: { ...process.env },
        cwd: fixtureProject,
      });
      const brokerText = `${brokerRun.stdout || ""}\n${brokerRun.stderr || ""}`;
      if (claudeLoginOrQuotaFailure(brokerText)) {
        return {
          native_shell,
          broker_tool: "unverified",
          error: brokerText.trim().slice(0, 500),
          cli_version: cliVersion,
        };
      }
      if (/ACTION_DENIED|COMMAND_POLICY|failed/i.test(brokerText) && !/\bok\b/.test(brokerText)) {
        broker_tool = "failed";
      }
    }

    return {
      native_shell,
      broker_tool,
      cli_version: cliVersion || String(versionOut).trim(),
      argv_sample: shellPrepared.argv.slice(0, 12),
    };
  } finally {
    if (prevHome === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prevHome;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export async function runHarnessVerify(args, io = { out: console.log, err: console.error }) {
  const [cli, ...rest] = args;
  if (!cli) {
    io.err("usage: team-up harness verify <claude> --fixture-project <path>");
    return 1;
  }
  const fixtureIdx = rest.indexOf("--fixture-project");
  const fixtureProject = fixtureIdx === -1 ? null : rest[fixtureIdx + 1];
  if (!fixtureProject) {
    io.err("usage: team-up harness verify <claude> --fixture-project <path>");
    return 1;
  }
  if (!fs.existsSync(fixtureProject)) {
    io.err(`fixture project missing: ${fixtureProject}`);
    return 1;
  }
  let adapter;
  try {
    adapter = getAdapter(cli);
  } catch (e) {
    io.err(String(e.message || e));
    return 1;
  }
  if (cli !== "claude") {
    io.err(`adapter ${cli} not ready for live verify in this revision`);
    return 2;
  }
  try {
    const record = await verifyHarness({
      adapter,
      fixtureProject,
      runner: Object.assign(liveClaudeVerifyRunner, {
        execFileSync,
      }),
    });
    io.out(`native_shell: ${record.native_shell}`);
    io.out(`broker_tool: ${record.broker_tool}`);
    io.out(`status: ${record.status}`);
    io.out(`cli_version: ${record.cli_version}`);
    return record.status === "verified" ? 0 : 2;
  } catch (e) {
    io.err(`BLOCKED: ${e.message}`);
    return 2;
  }
}
