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
  // Prefer result/assistant/error stream events — SessionStart hooks dump skills
  // that mention "subscription"/"authentication" and must not trip this gate.
  const lines = String(text || "").split(/\n/);
  const focused = [];
  let sawJson = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed[0] === "{") {
      sawJson = true;
      try {
        const obj = JSON.parse(trimmed);
        if (
          obj.type === "result" ||
          obj.type === "assistant" ||
          obj.type === "error" ||
          obj.is_error === true
        ) {
          focused.push(trimmed);
          if (obj.result) focused.push(String(obj.result));
          if (obj.error) focused.push(String(obj.error));
        }
      } catch {
        // ignore
      }
    } else if (!sawJson) {
      focused.push(trimmed);
    }
  }
  const t = (focused.length ? focused.join("\n") : String(text || "")).toLowerCase();
  return (
    /not logged in|please run .*login|authentication required|unauthorized|quota exceeded|rate limit exceeded|out of credit|credit balance/.test(
      t
    )
  );
}

function auditPath(runDir) {
  return path.join(runDir, "audit", "commands.jsonl");
}

function countAuditLines(runDir) {
  const p = auditPath(runDir);
  if (!fs.existsSync(p)) return 0;
  const text = fs.readFileSync(p, "utf8").trim();
  if (!text) return 0;
  return text.split("\n").length;
}

function lastAuditRecord(runDir) {
  const p = auditPath(runDir);
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/**
 * Parse Claude stream-json / JSON event lines into tool-use evidence.
 */
export function parseClaudeStreamEvents(text) {
  const events = [];
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const pushTool = (block, extra = {}) => {
      if (!block || typeof block !== "object") return;
      if (block.type === "tool_use" || block.name) {
        const err =
          block.error ??
          (typeof block.message === "string" ? block.message : undefined);
        events.push({
          type: "tool_use",
          name: block.name || block.tool_name,
          input: block.input,
          id: block.id,
          is_error: block.is_error === true || block.isError === true,
          ...(err != null ? { error: err } : {}),
          ...extra,
        });
      }
      if (block.type === "tool_result") {
        const err =
          block.error ??
          (typeof block.content === "string" ? block.content : undefined);
        events.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id || block.toolUseId,
          content: block.content,
          is_error: block.is_error === true || block.isError === true,
          ...(err != null ? { error: err } : {}),
          ...extra,
        });
      }
    };
    if (obj.type === "tool_use" || obj.name === "Bash") {
      pushTool(obj);
    }
    const content = obj.message?.content || obj.content || obj.tools;
    if (Array.isArray(content)) {
      for (const block of content) pushTool(block, { parent: obj.type });
    }
    if (Array.isArray(obj.tool_calls)) {
      for (const tc of obj.tool_calls) {
        pushTool({
          type: "tool_use",
          name: tc.name || tc.function?.name,
          input: tc.input || tc.function?.arguments,
          id: tc.id,
        });
      }
    }
    // Inventory / system events listing available tools
    const tools = obj.tools || obj.available_tools || obj.message?.tools;
    if (Array.isArray(tools)) {
      events.push({
        type: "tool_inventory",
        names: tools.map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean),
      });
    }
  }
  return events;
}

/**
 * Decide native_shell from structured tool evidence only.
 * Prose `NATIVE_SHELL_DENIED` without tool events → unverified.
 */
export function evaluateNativeShellFromStream({ events = [], text = "" } = {}) {
  void text;
  const bashUses = events.filter(
    (e) => e.type === "tool_use" && String(e.name || "").toLowerCase() === "bash"
  );
  const inventories = events.filter((e) => e.type === "tool_inventory");

  for (const use of bashUses) {
    if (
      use.is_error ||
      (use.error &&
        /disallowed|denied|not allowed|unavailable|rejected/i.test(String(use.error)))
    ) {
      return "denied";
    }
  }

  const bashResults = events.filter(
    (e) =>
      e.type === "tool_result" &&
      (e.is_error || /bash/i.test(String(e.name || e.content || "")))
  );
  if (bashResults.some((r) => r.is_error)) return "denied";

  if (
    events.some(
      (e) =>
        /bash/i.test(String(e.name || "")) &&
        (e.is_error || /denied|disallowed|rejected/i.test(String(e.error || e.content || "")))
    )
  ) {
    return "denied";
  }

  if (inventories.some((inv) => inv.names?.length && !inv.names.some((n) => /bash/i.test(n)))) {
    return "denied";
  }

  if (bashUses.length > 0) {
    // Bash tool_use present without rejection → allowed (successful or attempted)
    return "allowed";
  }

  return "unverified";
}

/**
 * Broker verification gate: only exact trimmed stdout `ok` plus a fresh audit
 * row may pass. Surrounding prose (`explanation\\nok`, `ok\\nextra`) is
 * unverified — never fabricate a pass from a substring match.
 */
export function decideBrokerToolFromEvidence({
  stdout = "",
  freshAudit = false,
  auditOk = false,
} = {}) {
  const exactOk = String(stdout || "").trim() === "ok";
  if (exactOk && freshAudit && auditOk) return "passed";
  return "unverified";
}

/**
 * Live Claude conformance: invoke the installed CLI with the prepared MCP
 * broker config. Never infer denial from argv alone and never grant the
 * command-broker capability from flag inspection or a direct MCP preflight.
 *
 * A direct MCP client call may diagnose the broker but cannot set
 * `broker_tool=passed`. Only the Claude invocation that produces exact `ok`
 * stdout and a fresh broker audit row may.
 *
 * Native-shell denial requires structured/stream JSON tool evidence — prompt
 * echo of NATIVE_SHELL_DENIED alone remains unverified. Arbitrary response
 * prose saying Bash is unavailable/denied must not be converted into
 * fabricated structured tool_use evidence.
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

    // Diagnostic MCP preflight — never promotes broker_tool to passed.
    let broker_preflight = "failed";
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
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      if (names.includes("project_test")) {
        const call = await client.callTool({ name: "project_test", arguments: {} });
        const body = call.content?.[0]?.text || "";
        const parsed = JSON.parse(body);
        broker_preflight =
          parsed.exit_code === 0 && parsed.stdout === "ok" ? "ok" : "failed";
      }
    } catch (e) {
      broker_preflight = "failed";
      if (claudeLoginOrQuotaFailure(e.message)) {
        return {
          native_shell: "unverified",
          broker_tool: "unverified",
          broker_preflight,
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

    // Preflight may have written an audit row — record baseline after it.
    const auditBaseline = countAuditLines(runDir);
    let broker_tool = "unverified";

    function prepareWithPrompt(prompt, { streamJson = false } = {}) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-verify-harness-"));
      const formatArgs = streamJson
        ? ["--print", "--verbose", "--output-format", "stream-json", prompt]
        : ["--print", "--output-format", "text", prompt];
      return adapter.prepareLaunch({
        argv: ["claude", ...formatArgs],
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

    // Real Claude invocation: ask it to run Bash. Denial needs structured evidence.
    const shellProbePrompt =
      "Use the Bash tool to run the command: echo SHELL_SHOULD_BE_DENIED. " +
      "If Bash is unavailable or rejected, do not invent success.";
    let shellPrepared;
    try {
      shellPrepared = prepareWithPrompt(shellProbePrompt, { streamJson: true });
    } catch (e) {
      return {
        native_shell: "unverified",
        broker_tool,
        broker_preflight,
        error: e.message,
        cli_version: cliVersion,
      };
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
        broker_preflight,
        error: `claude executable unavailable: ${shellRun.error.message}`,
      };
    }
    if (claudeLoginOrQuotaFailure(shellText) || (shellRun.status !== 0 && /login|auth|quota/i.test(shellText))) {
      return {
        native_shell: "unverified",
        broker_tool: "unverified",
        broker_preflight,
        error: shellText.trim().slice(0, 500) || "claude login/quota failure",
        cli_version: cliVersion,
      };
    }

    const streamEvents = parseClaudeStreamEvents(shellText);
    // Only parsed stream/tool inventory events prove Bash absent/rejected —
    // never promote arbitrary denial prose into fabricated tool_use rows.
    let native_shell = evaluateNativeShellFromStream({
      events: streamEvents,
      text: shellText,
    });
    // Successful Bash execution of the probe → allowed
    if (
      /SHELL_SHOULD_BE_DENIED/.test(shellText) &&
      streamEvents.some(
        (e) =>
          e.type === "tool_use" &&
          /bash/i.test(String(e.name || "")) &&
          !e.is_error &&
          !e.error
      )
    ) {
      native_shell = "allowed";
    }

    if (native_shell === "denied") {
      const brokerPrompt =
        "Call the MCP tool mcp__team_up_command_broker__project_test with no arguments. " +
        "Reply with the tool stdout only — exactly the characters ok and nothing else.";
      let brokerPrepared;
      try {
        brokerPrepared = prepareWithPrompt(brokerPrompt);
      } catch (e) {
        return {
          native_shell,
          broker_tool: "unverified",
          broker_preflight,
          error: e.message,
          cli_version: cliVersion,
        };
      }
      const brokerArgv = brokerPrepared.argv;
      const beforeAudit = countAuditLines(runDir);
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
          broker_preflight,
          error: brokerText.trim().slice(0, 500),
          cli_version: cliVersion,
        };
      }

      const afterAudit = countAuditLines(runDir);
      const freshAudit = afterAudit > beforeAudit && afterAudit > auditBaseline;
      const audit = lastAuditRecord(runDir);
      const auditOk =
        freshAudit &&
        audit &&
        (audit.action_id === "project-test" || audit.actionId === "project-test") &&
        (audit.exit_code === 0 || audit.exitCode === 0);

      broker_tool = decideBrokerToolFromEvidence({
        stdout: brokerRun.stdout || "",
        freshAudit,
        auditOk,
      });
      if (broker_tool !== "passed" && /ACTION_DENIED|COMMAND_POLICY/i.test(brokerText)) {
        broker_tool = "failed";
      }
    }

    return {
      native_shell,
      broker_tool,
      broker_preflight,
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
