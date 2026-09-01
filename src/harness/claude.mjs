import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { credentialDenyRules } from "../specialists/permissions.mjs";
import { CLAUDE_DECLARED_CAPABILITIES } from "./capabilities.mjs";

function homeChecksum(homePath) {
  const hash = crypto.createHash("sha256");
  const stack = [homePath];
  const files = [];
  while (stack.length) {
    const current = stack.pop();
    let st;
    try {
      st = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(current).sort()) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (st.isFile()) files.push(current);
  }
  for (const file of files.sort()) {
    hash.update(path.relative(homePath, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function cleanAbandonedStaging(runDir, keepName) {
  let entries = [];
  try {
    entries = fs.readdirSync(runDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(".claude-home-staging-")) continue;
    if (entry === keepName) continue;
    try {
      fs.rmSync(path.join(runDir, entry), { recursive: true, force: true });
    } catch {
      // best-effort cleanup of abandoned staging
    }
  }
}

/**
 * Keys that record nothing but "first-run setup already happened".
 *
 * A freshly materialized HOME is empty, so the CLI treats every capsule launch
 * as a first start and blocks on the interactive onboarding wizard (theme
 * picker, then login method, then an OAuth paste prompt) — bridged credentials
 * do not skip it. Copying these markers is what makes a headless launch
 * possible. Everything carrying project history, MCP wiring or tool state
 * stays out.
 */
const ONBOARDING_KEYS = [
  "hasCompletedOnboarding",
  "lastOnboardingVersion",
  "numStartups",
  "hasSeenTasksHint",
  "hasSeenAutoModeEntryWarning",
];

/**
 * Fresh attempt-specific Claude HOME built atomically from empty staging.
 * Contains only minimal auth plus selected skill surfaces. Never reuses a prior
 * mutable home directory in place.
 */
export function materializeClaudeAuthHome(runDir, {
  authSourceHome = process.env.HOME || os.homedir(),
  skillDirs = [],
  workspaceDirs = [],
  generationId = crypto.randomBytes(8).toString("hex"),
} = {}) {
  const stagingName = `.claude-home-staging-${generationId}`;
  const staging = path.join(runDir, stagingName);
  const finalHome = path.join(runDir, "claude-home");
  fs.rmSync(staging, { recursive: true, force: true });
  const claudeDir = path.join(staging, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });

  const credSrc = path.join(authSourceHome, ".claude", ".credentials.json");
  const credDest = path.join(claudeDir, ".credentials.json");
  try {
    if (fs.existsSync(credSrc)) {
      const st = fs.lstatSync(credSrc);
      if (!st.isSymbolicLink() && st.isFile()) {
        fs.copyFileSync(credSrc, credDest);
      } else {
        fs.writeFileSync(credDest, "{}\n", { mode: 0o600 });
      }
    } else {
      fs.writeFileSync(credDest, "{}\n", { mode: 0o600 });
    }
    fs.chmodSync(credDest, 0o600);
  } catch {
    try {
      fs.writeFileSync(credDest, "{}\n", { mode: 0o600 });
      fs.chmodSync(credDest, 0o600);
    } catch {
      // best-effort; live verify fails closed without usable auth
    }
  }

  // Selected skills must appear on the sanitized HOME surface Claude discovers.
  const skillsDest = path.join(claudeDir, "skills");
  fs.mkdirSync(skillsDest, { recursive: true, mode: 0o700 });
  for (const skillRoot of skillDirs) {
    if (!skillRoot || !fs.existsSync(skillRoot)) continue;
    for (const entry of fs.readdirSync(skillRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const src = path.join(skillRoot, entry.name);
      const dest = path.join(skillsDest, entry.name);
      fs.cpSync(src, dest, { recursive: true, dereference: false, errorOnExist: true });
    }
  }

  // Credentials alone leave the worker sitting in the first-run wizard, and an
  // unknown working directory then hits the workspace trust prompt. Both gates
  // are headless-fatal, so seed the markers that clear them. The user's other
  // projects stay unknown to the worker.
  const markers = {};
  try {
    const userConfig = JSON.parse(
      fs.readFileSync(path.join(authSourceHome, ".claude.json"), "utf8")
    );
    for (const key of ONBOARDING_KEYS) {
      if (userConfig[key] !== undefined) markers[key] = userConfig[key];
    }
  } catch {
    // No readable user config: the defaults below still suppress the wizard.
  }
  if (markers.hasCompletedOnboarding === undefined) markers.hasCompletedOnboarding = true;
  const projects = {};
  for (const dir of workspaceDirs) {
    if (!dir) continue;
    projects[dir] = {
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      projectOnboardingSeenCount: 1,
    };
  }
  if (Object.keys(projects).length) markers.projects = projects;
  fs.writeFileSync(
    path.join(staging, ".claude.json"),
    `${JSON.stringify(markers, null, 2)}\n`,
    { mode: 0o600 }
  );

  // Reject unexpected top-level entries beyond the two we just wrote.
  for (const entry of fs.readdirSync(staging)) {
    if (entry !== ".claude" && entry !== ".claude.json") {
      const err = new Error(`CLAUDE_HOME_UNEXPECTED: ${entry}`);
      err.code = "CLAUDE_HOME_UNEXPECTED";
      fs.rmSync(staging, { recursive: true, force: true });
      throw err;
    }
  }

  fs.rmSync(finalHome, { recursive: true, force: true });
  fs.renameSync(staging, finalHome);
  cleanAbandonedStaging(runDir, null);

  const checksum = homeChecksum(finalHome);
  return {
    home: finalHome,
    generationId,
    home_generation: generationId,
    checksum,
  };
}

export const claudeAdapter = {
  id: "claude",
  capabilities: CLAUDE_DECLARED_CAPABILITIES,

  sanitizeBrokeredArgv(argv) {
    const next = [];
    for (let i = 0; i < argv.length; i++) {
      if (
        argv[i] === "--dangerously-skip-permissions" ||
        argv[i] === "--allow-dangerously-skip-permissions"
      ) {
        continue;
      }
      if (argv[i] === "--permission-mode" && argv[i + 1] === "bypassPermissions") {
        i++;
        continue;
      }
      next.push(argv[i]);
    }
    return next;
  },

  version({ execFileSync }) {
    const out = execFileSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const text = String(out).trim();
    // Prefer leading semver: "2.1.220 (Claude Code)"
    const m = text.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)\b/);
    return m ? m[1] : text.split(/\s+/)[0] || text;
  },

  injectControl({ tmuxSession, message, execFileSync }) {
    execFileSync("tmux", ["send-keys", "-t", tmuxSession, "-l", message], {
      stdio: "ignore",
    });
    execFileSync("tmux", ["send-keys", "-t", tmuxSession, "Enter"], {
      stdio: "ignore",
    });
  },

  prepareLaunch({
    argv,
    runDir,
    broker = null,
    capsule = null,
    allowedBuiltins = ["Read", "Edit", "Write", "Glob", "Grep", "ToolSearch", "Skill"],
    nodePath = process.execPath,
    brokerBin,
    writeFileSync,
    mkdirSync,
    chmodSync,
  }) {
    const forbidden = [
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
    ];
    for (const flag of forbidden) {
      if (argv.includes(flag)) {
        const err = new Error(`HARNESS_POLICY: refusing ${flag}`);
        err.code = "HARNESS_POLICY";
        throw err;
      }
    }
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--permission-mode" && argv[i + 1] === "bypassPermissions") {
        const err = new Error("HARNESS_POLICY: refusing --permission-mode bypassPermissions");
        err.code = "HARNESS_POLICY";
        throw err;
      }
    }

    const harnessDir = `${runDir}/harness`;
    mkdirSync(harnessDir, { recursive: true });
    const mcpPath = `${harnessDir}/claude-mcp.json`;
    try {
      chmodSync(mcpPath, 0o644);
    } catch {
      // first write — file may not exist
    }

    const mcpServers = {
      ...(capsule?.mcpConfig?.mcpServers ?? {}),
      ...(broker ? {
        team_up_command_broker: {
          type: "stdio",
          command: nodePath,
          args: [brokerBin],
          env: {
            TEAM_UP_COMMAND_POLICY_SNAPSHOT: broker.policySnapshot,
            TEAM_UP_COMMAND_POLICY_CHECKSUM: broker.policyChecksum,
            TEAM_UP_PROJECT: broker.project,
            TEAM_UP_RUN_DIR: broker.runDir,
          },
        },
      } : {}),
    };
    const mcpConfig = { mcpServers };
    writeFileSync(mcpPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, { mode: 0o644 });
    try {
      chmodSync(mcpPath, 0o444);
    } catch {
      // best-effort immutable mode
    }

    const brokerTools = broker
      ? (broker.actionIds || []).map(
        (id) => `mcp__team_up_command_broker__${String(id).replace(/-/g, "_")}`
      )
      : [];
    const mcpTools = capsule?.mcpToolNames ?? Object.keys(mcpServers)
      .filter((name) => name !== "team_up_command_broker")
      .flatMap((name) => (capsule?.mcpToolsByServer?.[name] ?? []).map(
        (tool) => `mcp__${name}__${String(tool).replace(/-/g, "_")}`
      ));
    const tools = [...allowedBuiltins, ...brokerTools, ...mcpTools].join(",");

    const next = [...argv];
    // Do not inject --bare: on Claude 2.1.220 it breaks authentication.
    // Capsule isolation uses a run-specific auth-only HOME instead.
    while (next.includes("--bare")) {
      next.splice(next.indexOf("--bare"), 1);
    }
    for (const pluginDir of capsule?.pluginDirs ?? []) {
      next.push("--plugin-dir", pluginDir);
    }
    // Frameworks stay on --add-dir for prompt/instruction integration.
    // Skills are materialized into sanitized HOME/.claude/skills for native discovery.
    for (const dir of capsule?.frameworkDirs ?? []) {
      if (dir) next.push("--add-dir", dir);
    }
    if (!next.includes("--strict-mcp-config")) next.push("--strict-mcp-config");
    next.push("--mcp-config", mcpPath);
    next.push("--tools", tools);
    next.push("--allowedTools", tools);
    // Deny credential files unconditionally, alongside the shell. The capsule
    // closes the config surface; this closes the file read, and it applies to
    // `Grep` too because the rule is enforced where the file is opened.
    next.push("--disallowedTools", ["Bash", ...credentialDenyRules()].join(","));

    const env = {};
    const files = [mcpPath];
    let home_generation = null;
    let home_checksum = null;
    if (capsule) {
      const materialized = materializeClaudeAuthHome(runDir, {
        skillDirs: capsule.skillDirs ?? [],
        workspaceDirs: capsule.workspaceDirs ?? [],
      });
      env.HOME = materialized.home;
      home_generation = materialized.home_generation;
      home_checksum = materialized.checksum;
      files.push(path.join(materialized.home, ".claude", ".credentials.json"));
    }

    return {
      argv: next,
      env,
      files,
      home_generation,
      generationId: home_generation,
      home_checksum,
    };
  },
};
