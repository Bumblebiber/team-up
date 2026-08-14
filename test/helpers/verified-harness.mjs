import fs from "node:fs";
import path from "node:path";

export const FAKE_CLAUDE_VERSION = "2.1.220";

/**
 * A deterministic Claude stub on PATH plus a seeded verification record, so a
 * unit test can exercise launches that require a harness able to prove
 * team-up.context-isolation/v1 without invoking a real CLI.
 */
export function writeFakeClaude(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s (Claude Code)\\n' ${JSON.stringify(FAKE_CLAUDE_VERSION)}
  exit 0
fi
exit 0
`;
  const claudePath = path.join(binDir, "claude");
  fs.writeFileSync(claudePath, script, { mode: 0o755 });
  return claudePath;
}

export function seedVerifiedClaude(home, { cliVersion = FAKE_CLAUDE_VERSION } = {}) {
  const dir = path.join(home, "harness-verification", "claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${cliVersion}.json`),
    JSON.stringify({
      adapter: "claude",
      cli_version: cliVersion,
      status: "verified",
      native_shell: "denied",
      broker_tool: "passed",
      command_broker: "team-up.command-broker/v1",
    })
  );
  return dir;
}

/** Roster whose only cell is the verified fake Claude. */
export function verifiedClaudeRoster({ tier = "medium", reasoning = { low: null } } = {}) {
  return {
    accounts: { claude: { kind: "subscription", enabled: true } },
    clis: { claude: { cmd: ["claude", "--model", "{model}", "{prompt}"] } },
    models: {
      m: {
        tier,
        cli: ["claude"],
        account: "claude",
        reasoning,
        priority: 1,
      },
    },
  };
}

/**
 * Prepare a TEAM_UP_HOME with a verified Claude harness on PATH.
 * Returns the env overlay the caller should apply.
 */
export function verifiedHarnessEnv(home) {
  const binDir = path.join(home, "bin");
  writeFakeClaude(binDir);
  seedVerifiedClaude(home);
  return {
    TEAM_UP_HOME: home,
    TEAM_UP_RUNS: path.join(home, "runs"),
    TEAM_UP_ROSTER: path.join(home, "roster.json"),
    TEAM_UP_USAGE: path.join(home, "usage.json"),
    PATH: `${binDir}:${process.env.PATH}`,
  };
}
