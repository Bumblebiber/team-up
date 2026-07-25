import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeApprovedAction } from "../../src/commands/execute.mjs";

test("executes exact argv without a shell and audits result", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-project-"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-run-"));
  const policy = {
    schema_version: 1,
    commands: {
      "project-test": {
        argv: [process.execPath, "-e", "process.stdout.write('ok')"],
        cwd: ".",
        timeout_seconds: 10,
        environment: {},
      },
    },
  };
  const result = await executeApprovedAction({
    actionId: "project-test",
    policy,
    project,
    runDir,
  });
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.shell, false);
  assert.match(fs.readFileSync(path.join(runDir, "audit", "commands.jsonl"), "utf8"), /project-test/);
});

test("rejects an undeclared action", async () => {
  await assert.rejects(
    executeApprovedAction({ actionId: "git-push", policy: { schema_version: 1, commands: {} }, project: ".", runDir: "." }),
    /ACTION_DENIED/
  );
});

test("times out slow commands", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-project-"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-run-"));
  await assert.rejects(
    executeApprovedAction({
      actionId: "slow",
      policy: {
        schema_version: 1,
        commands: {
          slow: {
            argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
            cwd: ".",
            timeout_seconds: 1,
            environment: {},
          },
        },
      },
      project,
      runDir,
    }),
    /COMMAND_TIMEOUT/
  );
});
