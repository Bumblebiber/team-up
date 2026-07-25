<!-- o9k-provenance
who: codex:gpt-5
when: 2026-07-25T15:08:05Z
why: Create the detailed TDD implementation plan for the approved team-up runtime supervision design.
trigger: User reviewed and approved the written runtime supervision specification.
host: codex
-->
# Team-up Runtime Supervision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make approved specialists operational with a shared command broker, exact-profile harness filtering, advisory token targets, durable quota handoff, normalized reset reporting, and cancellable automatic resumption.

**Architecture:** `team-up` owns one canonical command policy and exposes approved actions through an MCP broker. Small harness adapters disable native shell access and make only broker tools available; the resolver excludes incompatible CLI/model cells before constructing an exact-tier chain. A deterministic controller monitors normalized provider usage and mailbox heartbeats, records immutable attempts under one run, performs 90/95-percent handoff, and persists capacity waits across restarts.

**Tech Stack:** Node.js 24 with Node `>=18` compatibility, ES modules, native `node:test`, `@modelcontextprotocol/sdk@1.29.0`, `zod@4.4.3`, JSON/JSONL state, TMUX, existing usage collectors and mailbox protocol.

---

## Execution Context

Use the existing local repositories:

- Engine: `/home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up`
- Hannes: `/home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up-with-hannes`
- Hugo: `/home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up-with-hugo`
- o9k adapter worktree: `/home/bbbee/projects/o9k/.worktrees/team-up-adapter`

Read the approved design before implementation:

```bash
cd /home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up
sed -n '1,560p' docs/specs/2026-07-25-runtime-supervision-design.md
```

Do not modify the dirty o9k main checkout. Do not add remotes, publish, merge,
or change live `~/.o9k/roster.json` / `~/.team-up/roster.json` during plan
execution.

## Target File Structure

New focused modules:

```text
src/
  commands/
    policy.mjs          # validate, hash, approve, and snapshot project actions
    execute.mjs         # direct argv execution and bounded JSONL audit
    mcp-server.mjs      # stdio MCP server exposing one tool per approved action
  harness/
    registry.mjs        # adapter lookup and capability contract
    claude.mjs          # first conforming adapter
    unsupported.mjs     # explicit fail-closed adapter for unverified harnesses
    verify.mjs          # version-keyed adapter conformance records
  specialists/
    budget.mjs          # schema-v1 migration and schema-v2 advisory budget
  supervisor/
    attempts.mjs        # immutable attempts and atomic active lease
    checkpoint.mjs      # typed checkpoint validation/materialization
    capacity.mjs        # candidate/chain reset calculation
    controller.mjs      # pure transition planner and side-effect executor
    waits.mjs           # persistent scheduled recheck/cancellation
bin/
  team-up-command-broker.mjs
```

Keep `src/runs/runs.mjs` as the generic mailbox/run registry. Do not move all
supervision into that already large file.

### Task 1: Convert Hard Token Budgets to Explicit Advisory Targets

**Files:**

- Create: `src/specialists/budget.mjs`
- Modify: `src/specialists/manifest.mjs`
- Modify: `src/specialists/launcher.mjs`
- Modify: `src/specialists/adapters.mjs`
- Test: `test/specialists/budget.test.mjs`
- Modify: `/home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up-with-hannes/specialist.json`
- Modify: `/home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up-with-hugo/specialist.json`

- [ ] **Step 1: Write failing budget normalization tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBudget } from "../../src/specialists/budget.mjs";

test("schema-v2 advisory token target", () => {
  assert.deepEqual(
    normalizeBudget({
      timeout_seconds: 1800,
      tokens: { target: 80000, enforcement: "advisory" },
    }),
    {
      timeout_seconds: 1800,
      tokens: { target: 80000, enforcement: "advisory" },
      warnings: [],
    }
  );
});

test("schema-v1 max_tokens migrates without hard enforcement", () => {
  const result = normalizeBudget({ timeout_seconds: 1800, max_tokens: 80000 });
  assert.equal(result.tokens.target, 80000);
  assert.equal(result.tokens.enforcement, "advisory");
  assert.match(result.warnings[0], /max_tokens.*advisory/);
});

test("hard enforcement is rejected until an adapter exists", () => {
  assert.throws(
    () => normalizeBudget({ tokens: { target: 80000, enforcement: "hard" } }),
    /unsupported token enforcement/
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/specialists/budget.test.mjs
```

Expected: FAIL because `src/specialists/budget.mjs` does not exist.

- [ ] **Step 3: Implement `normalizeBudget`**

```js
export function normalizeBudget(input = {}) {
  const warnings = [];
  const timeout = input.timeout_seconds ?? null;
  let tokens = input.tokens ?? null;

  if (tokens == null && input.max_tokens != null) {
    tokens = { target: input.max_tokens, enforcement: "advisory" };
    warnings.push("budget.max_tokens is deprecated and treated as advisory");
  }
  if (tokens != null) {
    if (!Number.isInteger(tokens.target) || tokens.target <= 0) {
      throw new Error("budget.tokens.target must be a positive integer");
    }
    if ((tokens.enforcement ?? "advisory") !== "advisory") {
      throw new Error("unsupported token enforcement: only advisory is available");
    }
    tokens = { target: tokens.target, enforcement: "advisory" };
  }
  if (timeout != null && (!Number.isInteger(timeout) || timeout <= 0)) {
    throw new Error("budget.timeout_seconds must be a positive integer");
  }
  return { timeout_seconds: timeout, tokens, warnings };
}
```

Call this function from manifest validation and launch normalization. Remove
the `TOKEN_BUDGET_UNENFORCEABLE` launch gate and the empty token-adapter
registry. Store the normalized advisory target in `STATE.json`; keep timeout
enforcement unchanged. Manifest validation accepts schema versions 1 and 2:
version 1 permits legacy `max_tokens` and emits the migration warning; version
2 permits only the nested `tokens` shape.

- [ ] **Step 4: Update both starter manifests**

Use this budget shape in both repositories:

```json
"schema_version": 2,
"budget": {
  "timeout_seconds": 1800,
  "tokens": {
    "target": 80000,
    "enforcement": "advisory"
  }
}
```

Keep Hannes's `command.test` and `project-test` declarations unchanged.

- [ ] **Step 5: Run focused and existing specialist tests**

```bash
node --test test/specialists/budget.test.mjs test/specialists/manifest.test.mjs test/specialists/launcher.test.mjs test/integration/starter-specialists.test.mjs
```

Expected: all pass; no test expects `TOKEN_BUDGET_UNENFORCEABLE`.

- [ ] **Step 6: Commit each repository**

```bash
git add src/specialists/budget.mjs src/specialists/manifest.mjs src/specialists/launcher.mjs src/specialists/adapters.mjs test/specialists/budget.test.mjs
git commit -m "feat(budget): make specialist token targets advisory"

git -C /home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up-with-hannes add specialist.json
git -C /home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up-with-hannes commit -m "feat(manifest): use advisory token target"

git -C /home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up-with-hugo add specialist.json
git -C /home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up-with-hugo commit -m "feat(manifest): use advisory token target"
```

### Task 2: Make Operating-System Isolation Explicitly Best Effort

**Files:**

- Modify: `src/sandbox/systemd.mjs`
- Modify: `src/specialists/launcher.mjs`
- Test: `test/sandbox/best-effort.test.mjs`
- Modify: `docs/specialists.md`

- [ ] **Step 1: Write failing best-effort tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { wrapWithSandbox } from "../../src/sandbox/systemd.mjs";

test("ineffective host sandbox falls back with an audit warning", () => {
  const result = wrapWithSandbox({
    command: ["/usr/bin/true"],
    permissions: { filesystem: "project", network: false, writes: false },
    cwd: "/tmp",
    projectPath: "/tmp",
    probe: () => false,
    enforcement: "best_effort",
  });
  assert.deepEqual(result.argv, ["/usr/bin/true"]);
  assert.equal(result.sandbox, "none");
  assert.equal(result.enforced, false);
  assert.match(result.warning, /best-effort sandbox unavailable/);
});

test("effective host sandbox is still used", () => {
  const result = wrapWithSandbox({
    command: ["/usr/bin/true"],
    permissions: { filesystem: "project", network: false, writes: false },
    cwd: "/tmp",
    projectPath: "/tmp",
    probe: () => true,
    enforcement: "best_effort",
  });
  assert.equal(result.sandbox, "systemd-run-user");
  assert.equal(result.enforced, true);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/sandbox/best-effort.test.mjs
```

Expected: the first test throws `SANDBOX_UNAVAILABLE`.

- [ ] **Step 3: Implement explicit best-effort fallback**

Add `enforcement = "required"` to `wrapWithSandbox`. When
`enforcement === "best_effort"` and the semantic probe fails, return the
original argv plus:

```js
{
  sandbox: "none",
  enforced: false,
  warning: "best-effort sandbox unavailable; trusted specialist runs without OS isolation",
}
```

Keep `required` fail-closed for callers outside the approved trusted-specialist
path. The specialist launcher always passes `enforcement: "best_effort"` and
records the returned status/warning in run state and result audit.

- [ ] **Step 4: Correct the semantic probe independence**

Keep the home sentinel below `$HOME`, but create the no-exec probe script under
a separate temporary directory outside `$HOME`. Add a test where home hiding
works but executable blocking does not; `systemdAvailable()` must return false.
This prevents a false positive even though the specialist path now tolerates an
unavailable sandbox.

- [ ] **Step 5: Remove the early launcher override**

Delete the `sandbox.available === false` unconditional launch rejection. Tests
must pass an injected `probe: () => false` and assert that the run reaches
harness preparation with `sandbox.enforced === false`.

- [ ] **Step 6: Run and commit**

```bash
node --test test/sandbox/*.test.mjs test/specialists/launcher-probe.test.mjs
git add src/sandbox/systemd.mjs src/specialists/launcher.mjs test/sandbox/best-effort.test.mjs docs/specialists.md
git commit -m "feat(sandbox): make specialist isolation best effort"
```

### Task 3: Validate and Snapshot Project Command Policies

**Files:**

- Create: `src/commands/policy.mjs`
- Modify: `src/specialists/approvals.mjs`
- Modify: `src/specialists/launcher.mjs`
- Test: `test/commands/policy.test.mjs`
- Test: `test/specialists/command-approval.test.mjs`

- [ ] **Step 1: Write failing policy tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateCommandPolicy,
  commandPolicyChecksum,
  snapshotCommandPolicy,
} from "../../src/commands/policy.mjs";

const valid = {
  schema_version: 1,
  commands: {
    "project-test": {
      argv: ["npm", "test"],
      cwd: ".",
      timeout_seconds: 1800,
      environment: {},
    },
  },
};

test("validates fixed argv policy", () => {
  assert.deepEqual(validateCommandPolicy(valid), { ok: true, errors: [] });
});

test("rejects shell strings, cwd escape, env overrides, and unknown keys", () => {
  for (const policy of [
    { schema_version: 1, commands: { x: { argv: "npm test", cwd: "." } } },
    { schema_version: 1, commands: { x: { argv: ["sh", "-c", "npm test"], cwd: "." } } },
    { schema_version: 1, commands: { x: { argv: ["npm", "test"], cwd: "../escape" } } },
    { schema_version: 1, commands: { x: { argv: ["npm", "test"], cwd: ".", extra: true } } },
  ]) {
    assert.equal(validateCommandPolicy(policy).ok, false);
  }
});

test("snapshot is immutable and checksum bound", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-policy-"));
  const snap = snapshotCommandPolicy({ policy: valid, runDir });
  assert.equal(snap.checksum, commandPolicyChecksum(valid));
  assert.equal(fs.statSync(snap.path).mode & 0o222, 0);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/commands/policy.test.mjs
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement strict policy validation**

`src/commands/policy.mjs` must export:

```js
export const COMMAND_POLICY_FILE = ".team-up/commands.json";
export function validateCommandPolicy(policy) {}
export function loadProjectCommandPolicy(project) {}
export function commandPolicyChecksum(policy) {}
export function snapshotCommandPolicy({ policy, runDir }) {}
export function actionFor(policy, actionId) {}
```

Validation rules:

- top-level keys are exactly `schema_version` and `commands`;
- action IDs match `/^[a-z][a-z0-9-]{0,63}$/`;
- `argv` is a non-empty string array;
- executable is not `sh`, `bash`, `zsh`, `fish`, `cmd`, or PowerShell;
- no argument contains NUL;
- `cwd` is relative, normalized, and cannot escape project root;
- `timeout_seconds` is a positive integer;
- `environment` is empty in MVP;
- action keys are exactly `argv`, `cwd`, `timeout_seconds`, `environment`.

Hash canonical JSON with sorted object keys and SHA-256. Write the snapshot to
`<runDir>/policy/commands.json`, mode `0444`, using atomic rename.

- [ ] **Step 4: Bind approvals to the policy checksum**

Extend `approvalKey`, approval records, and `isApproved` with
`command_policy_checksum`. Specialists with no declared commands use `null`.
A specialist declaring commands cannot be approved without a project policy
containing every declared action. A later policy change must produce
`NOT_APPROVED`, not silently use the old project file.

Add this assertion:

```js
assert.equal(
  isApproved({
    project,
    id: "testing.hannes",
    version,
    checksum: packageChecksum,
    permissions,
    command_policy_checksum: changedChecksum,
    env,
  }),
  false
);
```

- [ ] **Step 5: Snapshot only after approval and integrity checks**

In `launch`, load and hash the project policy, include its hash in the approval
check, create the run, then snapshot it. Pass only the snapshot path to later
broker configuration.

- [ ] **Step 6: Run tests**

```bash
node --test test/commands/policy.test.mjs test/specialists/command-approval.test.mjs test/specialists/approvals.test.mjs
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/commands/policy.mjs src/specialists/approvals.mjs src/specialists/launcher.mjs test/commands/policy.test.mjs test/specialists/command-approval.test.mjs
git commit -m "feat(commands): bind approvals to immutable project policy"
```

### Task 4: Implement the Direct Command Executor and Audit Log

**Files:**

- Create: `src/commands/execute.mjs`
- Test: `test/commands/execute.test.mjs`

- [ ] **Step 1: Write failing executor tests**

```js
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
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/commands/execute.test.mjs
```

- [ ] **Step 3: Implement direct execution**

Use `spawn` with:

```js
{
  cwd: resolvedCwd,
  env: sanitizedEnvironment,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
}
```

The sanitized environment contains only:

```js
["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI"]
```

Resolve executable names through the inherited `PATH`; never invoke a shell.
Enforce timeout with `AbortController`. Bound captured stdout and stderr to
1 MiB each and mark truncation. Append one JSON object per invocation to
`audit/commands.jsonl`, excluding secrets and full inherited environment.

- [ ] **Step 4: Add timeout and truncation tests**

Test:

```js
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
```

- [ ] **Step 5: Run and commit**

```bash
node --test test/commands/execute.test.mjs
git add src/commands/execute.mjs test/commands/execute.test.mjs
git commit -m "feat(commands): execute approved actions without a shell"
```

### Task 5: Expose Approved Actions Through an MCP Broker

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/commands/mcp-server.mjs`
- Create: `bin/team-up-command-broker.mjs`
- Test: `test/commands/mcp-server.test.mjs`

- [ ] **Step 1: Write a failing in-process broker test**

Test the exported tool descriptors without starting a paid harness:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { brokerToolName, listBrokerTools } from "../../src/commands/mcp-server.mjs";

test("one no-argument MCP tool per approved action", () => {
  const policy = {
    schema_version: 1,
    commands: {
      "project-test": {
        argv: ["npm", "test"],
        cwd: ".",
        timeout_seconds: 1800,
        environment: {},
      },
    },
  };
  assert.equal(brokerToolName("project-test"), "project_test");
  assert.deepEqual(listBrokerTools(policy).map((x) => x.name), ["project_test"]);
  assert.deepEqual(listBrokerTools(policy)[0].inputSchema, { type: "object", properties: {}, additionalProperties: false });
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
node --test test/commands/mcp-server.test.mjs
```

Expected: FAIL because `src/commands/mcp-server.mjs` does not exist.

- [ ] **Step 3: Add exact dependencies**

```bash
npm install --save-exact @modelcontextprotocol/sdk@1.29.0 zod@4.4.3
```

Expected: `package.json` and `package-lock.json` contain exact versions.

- [ ] **Step 4: Implement the server**

`createBrokerServer({ policyPath, project, runDir })` must:

- load only the immutable snapshot path;
- register one tool per action;
- reject every non-empty tool argument object;
- call `executeApprovedAction`;
- return bounded stdout/stderr and exit metadata as MCP content;
- expose no generic `run`, `shell`, or arbitrary-action tool.

Use:

```js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
```

The bin entry reads only:

```text
TEAM_UP_COMMAND_POLICY_SNAPSHOT
TEAM_UP_PROJECT
TEAM_UP_RUN_DIR
```

and exits nonzero if any path is absent or invalid.

- [ ] **Step 5: Add a stdio protocol smoke test**

Spawn `node bin/team-up-command-broker.mjs`, send MCP initialize,
`tools/list`, and `tools/call` messages using the SDK client transport. Assert
that only `project_test` is listed and its fixed fixture command runs.

- [ ] **Step 6: Run and commit**

```bash
node --test test/commands/mcp-server.test.mjs test/commands/execute.test.mjs
git add package.json package-lock.json src/commands/mcp-server.mjs bin/team-up-command-broker.mjs test/commands/mcp-server.test.mjs
git commit -m "feat(commands): expose approved actions through MCP"
```

### Task 6: Add Harness Adapter Contract and a Conforming Claude Adapter

**Files:**

- Create: `src/harness/registry.mjs`
- Create: `src/harness/claude.mjs`
- Create: `src/harness/unsupported.mjs`
- Create: `src/harness/verify.mjs`
- Modify: `src/specialists/launcher.mjs`
- Modify: `src/roster/command.mjs`
- Modify: `src/cli.mjs`
- Test: `test/harness/registry.test.mjs`
- Test: `test/harness/claude.test.mjs`
- Test: `test/harness/verify.test.mjs`

- [ ] **Step 1: Write failing registry tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  declaredHarnessCapabilities,
  harnessCapabilities,
  prepareHarnessLaunch,
} from "../../src/harness/registry.mjs";

test("claude advertises brokered commands; unverified harnesses do not", () => {
  assert.equal(declaredHarnessCapabilities("claude").command_broker, "team-up.command-broker/v1");
  assert.equal(harnessCapabilities("claude", { verification: null }).command_broker, null);
  assert.equal(
    harnessCapabilities("claude", { verification: { status: "verified", cli_version: "fixture" } }).command_broker,
    "team-up.command-broker/v1"
  );
  for (const id of ["cursor", "codex", "hermes", "opencode"]) {
    assert.equal(harnessCapabilities(id).command_broker, null);
  }
});

test("unknown harness fails closed", () => {
  assert.throws(() => prepareHarnessLaunch({ cli: "unknown" }), /HARNESS_UNSUPPORTED/);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/harness/registry.test.mjs
```

- [ ] **Step 3: Implement the adapter contract**

Every adapter exports:

```js
{
  id,
  capabilities,
  prepareLaunch({ argv, runDir, broker, allowedBuiltins }),
  injectControl({ tmuxSession, message, execFileSync }),
  version({ execFileSync })
}
```

`prepareLaunch` returns `{ argv, env, files }`. The generic registry must never
treat a roster boolean as proof of support.

- [ ] **Step 4: Implement Claude launch preparation**

Starting from the roster-generated argv:

- reject `--dangerously-skip-permissions`,
  `--allow-dangerously-skip-permissions`, and
  `--permission-mode bypassPermissions`;
- add `--strict-mcp-config`;
- add `--mcp-config <runDir>/harness/claude-mcp.json`;
- add `--tools Read,Edit,Write,Glob,Grep,mcp__team_up_command_broker__project_test`;
- add `--disallowedTools Bash`;
- keep model and effort arguments selected by the roster;
- write the MCP config mode `0444` outside the worker workspace.

The MCP JSON is:

```json
{
  "mcpServers": {
    "team_up_command_broker": {
      "type": "stdio",
      "command": "/absolute/node",
      "args": ["/absolute/bin/team-up-command-broker.mjs"],
      "env": {
        "TEAM_UP_COMMAND_POLICY_SNAPSHOT": "/absolute/run/policy/commands.json",
        "TEAM_UP_PROJECT": "/absolute/project",
        "TEAM_UP_RUN_DIR": "/absolute/run"
      }
    }
  }
}
```

Use direct TMUX argv injection for control messages; never construct a shell
command. Unit-test `execFileSync("tmux", ["send-keys", "-t", session, "-l",
message])` followed by Enter as a separate call.

- [ ] **Step 5: Add version-keyed conformance records**

Store records under:

```text
~/.team-up/harness-verification/<adapter>/<cli-version>.json
```

The record contains adapter ID, CLI version, checked timestamp, raw-shell-deny
result, broker-tool result, and overall status. `team-up harness verify
claude --fixture-project <path>` performs a bounded live probe. A changed CLI
version has no valid record until reverified.

`declaredHarnessCapabilities(cli)` describes what built-in adapter code can
support. `harnessCapabilities(cli)` returns those capabilities only when a
successful record exists for the adapter's currently detected CLI version;
otherwise it returns the explicit unverified capability set. Resolver
eligibility always uses the latter.

Unit tests use a fake runner and assert both required checks. Do not invoke a
paid model in unit tests.

- [ ] **Step 6: Mark other harnesses explicitly unsupported**

Cursor, Codex, Hermes, and OpenCode remain usable in the global roster but
report:

```js
{ command_broker: null, native_shell: "unverified", mcp: "unverified" }
```

They must not enter a specialist chain requiring commands until a later
adapter passes the same contract. Do not fake parity with flags.

- [ ] **Step 7: Run and commit**

```bash
node --test test/harness/*.test.mjs
git add src/harness src/specialists/launcher.mjs src/roster/command.mjs src/cli.mjs test/harness
git commit -m "feat(harness): add verified command-broker adapters"
```

### Task 7: Filter Specialist Chains by Harness Capabilities

**Files:**

- Modify: `src/roster/profile.mjs`
- Modify: `src/specialists/launcher.mjs`
- Test: `test/roster/profile-capabilities.test.mjs`
- Modify: `roster.example.json`

- [ ] **Step 1: Write failing exact-profile capability tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveProfile } from "../../src/roster/profile.mjs";

test("command specialist chain excludes unverified harnesses", () => {
  const result = resolveProfile({
    roster,
    usage: {},
    profile: { tier: "frontier", reasoning: "max" },
    requirements: { command_broker: "team-up.command-broker/v1" },
    harnessCapabilities: (cli) =>
      cli === "claude"
        ? { command_broker: "team-up.command-broker/v1" }
        : { command_broker: null },
  });
  assert.deepEqual(result.chain.map((x) => x.cli), ["claude"]);
  assert.ok(result.skipped.some((x) => /command broker/.test(x.reason)));
});

test("capability filtering never admits another tier", () => {
  const result = resolveProfile({
    roster,
    usage: {},
    profile: { tier: "frontier", reasoning: "max" },
    requirements: { command_broker: "team-up.command-broker/v1" },
    harnessCapabilities: () => ({ command_broker: null }),
  });
  assert.equal(result.code, "PROFILE_UNAVAILABLE");
  assert.deepEqual(result.chain, []);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/roster/profile-capabilities.test.mjs
```

- [ ] **Step 3: Extend `resolveProfile`**

Add optional arguments:

```js
requirements = {},
harnessCapabilities = defaultHarnessCapabilities
```

Apply capability checks after CLI template validation and before usage gates.
The launcher derives:

```js
const requirements = manifest.permissions.commands.length
  ? { command_broker: "team-up.command-broker/v1" }
  : {};
```

Remove the old late `ALLOWLIST_UNENFORCEABLE` boolean check. Failure now occurs
as `PROFILE_UNAVAILABLE` with candidate-specific reasons before run creation.

- [ ] **Step 4: Update the example roster**

Delete obsolete `mediated_commands` and `token_budget_adapter` fields. Explain
that adapter support comes from installed `team-up` code plus conformance
records, never from user assertions.

- [ ] **Step 5: Run and commit**

```bash
node --test test/roster/profile.test.mjs test/roster/profile-capabilities.test.mjs test/roster/example-resolve.test.mjs
git add src/roster/profile.mjs src/specialists/launcher.mjs test/roster/profile-capabilities.test.mjs roster.example.json
git commit -m "feat(roster): filter specialist chains by harness capability"
```

### Task 8: Normalize Usage Reset Times and Compute Chain Availability

**Files:**

- Modify: `src/collectors/parse-claude-usage.mjs`
- Modify: `src/collectors/parse-codex-status.mjs`
- Modify: `src/collectors/parse-cursor-usage.mjs`
- Modify: `src/usage/usage-collect.mjs`
- Modify: `src/usage/usage-windows.mjs`
- Create: `src/supervisor/capacity.mjs`
- Test: `test/usage/reset-contract.test.mjs`
- Test: `test/supervisor/capacity.test.mjs`

- [ ] **Step 1: Write failing reset-contract tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeUsage } from "../../src/collectors/parse-claude-usage.mjs";
import { parseCursorUsage } from "../../src/collectors/parse-cursor-usage.mjs";

test("collector preserves raw reset and emits ISO reset", () => {
  const windows = parseClaudeUsage(
    "Current 5h: 96% used · resets Jul 25, 8:10pm (Europe/Berlin)",
    { now: "2026-07-25T16:00:00Z" }
  );
  assert.equal(windows["claude:5h"].resets_at_raw, "Jul 25, 8:10pm (Europe/Berlin)");
  assert.equal(windows["claude:5h"].resets_at, "2026-07-25T18:10:00.000Z");
  assert.equal(windows["claude:5h"].reset_confidence, "provider");
});

test("unknown cursor reset is explicit", () => {
  const windows = parseCursorUsage("Included 91% used");
  assert.equal(windows["cursor:included"].resets_at, null);
  assert.equal(windows["cursor:included"].reset_confidence, "unknown");
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/usage/reset-contract.test.mjs
```

- [ ] **Step 3: Normalize every window**

Every stored window must contain:

```js
{
  window,
  used,
  resets_at,
  resets_at_raw,
  reset_confidence,
  updated_at,
  source,
}
```

Keep legacy `updated` on read, but write `updated_at`. Preserve the existing
`parseResetAt(raw, now)` contract of epoch milliseconds or `null`, because
window gating compares it numerically. Add
`normalizeResetAt(raw, now)`, which converts that epoch to an ISO string for
collector output. Both functions inject `now` for year-rollover tests. Never
synthesize a reset time from the maximum-age staleness fallback; that fallback
only decides whether stale usage still blocks.

- [ ] **Step 4: Implement candidate and chain availability**

`src/supervisor/capacity.mjs` exports:

```js
export function candidateAvailability({ candidate, usage, roster, now }) {}
export function chainCapacityReport({ profileResult, usage, roster, now }) {}
```

For each candidate, collect currently blocking windows. Its availability time
is the latest known reset among those windows. The chain's `next_reset_at` is
the earliest fully available candidate. If any required blocking reset is
unknown, preserve `null` and list that window explicitly.

- [ ] **Step 5: Run and commit**

```bash
node --test test/usage/*.test.mjs test/supervisor/capacity.test.mjs
git add src/collectors src/usage src/supervisor/capacity.mjs test/usage/reset-contract.test.mjs test/supervisor/capacity.test.mjs
git commit -m "feat(usage): normalize provider reset times"
```

### Task 9: Add Immutable Attempts and Atomic Worker Leases

**Files:**

- Create: `src/supervisor/attempts.mjs`
- Modify: `src/runs/runs.mjs`
- Test: `test/supervisor/attempts.test.mjs`

- [ ] **Step 1: Write failing state tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireAttemptLease,
  createAttempt,
  releaseAttemptLease,
} from "../../src/supervisor/attempts.mjs";

test("only expected predecessor can acquire the next lease", () => {
  const first = createAttempt({ runId, runtime: { cli: "claude", model: "a" } });
  assert.equal(acquireAttemptLease({ runId, attemptId: first.id, expectedPrevious: null }).ok, true);
  const second = createAttempt({ runId, runtime: { cli: "claude", model: "b" } });
  assert.equal(acquireAttemptLease({ runId, attemptId: second.id, expectedPrevious: "wrong" }).ok, false);
  releaseAttemptLease({ runId, attemptId: first.id, reason: "handoff" });
  assert.equal(acquireAttemptLease({ runId, attemptId: second.id, expectedPrevious: first.id }).ok, true);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/supervisor/attempts.test.mjs
```

- [ ] **Step 3: Implement attempt storage**

Store:

```text
<run>/ATTEMPTS.json
<run>/ACTIVE_LEASE.json
<run>/attempts/<attempt-id>/STATE.json
```

Attempt IDs are monotonic within a run (`a0001`, `a0002`). Records are
append-only except for status/heartbeat fields in the attempt's own state.
Lease updates use a lock file with `openSync(..., "wx")`, atomic JSON writes,
and an expected-previous compare.

- [ ] **Step 4: Extend run state**

Add:

```js
{
  specialist: { id, version, checksum },
  current_attempt_id,
  attempt_count,
  supervision: { enabled: true }
}
```

Keep generic Path-B runs backward compatible: absent `supervision` means old
behavior.

- [ ] **Step 5: Run and commit**

```bash
node --test test/supervisor/attempts.test.mjs test/runs/*.test.mjs
git add src/supervisor/attempts.mjs src/runs/runs.mjs test/supervisor/attempts.test.mjs
git commit -m "feat(supervisor): add durable attempts and worker leases"
```

### Task 10: Implement Typed Checkpoints and the Handoff State Machine

**Files:**

- Create: `src/supervisor/checkpoint.mjs`
- Create: `src/supervisor/controller.mjs`
- Modify: `src/specialists/launcher.mjs`
- Modify: `src/usage/usage-watcher.mjs`
- Test: `test/supervisor/checkpoint.test.mjs`
- Test: `test/supervisor/controller.test.mjs`

- [ ] **Step 1: Write checkpoint validation tests**

The checkpoint schema requires:

```js
{
  schema: "team-up.checkpoint/v1",
  run_id,
  attempt_id,
  status: "complete" | "partial",
  summary,
  completed: [],
  open: [],
  artifacts: [],
  verification_commands: [],
  risks: [],
  questions: [],
  repository: { head, dirty, diff_stat },
  created_at,
}
```

Reject mismatched run/attempt IDs and unknown fields. Accept a partial
controller-generated checkpoint when the worker exits without `handoff_ready`.

- [ ] **Step 2: Write pure transition tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { decideTransition } from "../../src/supervisor/controller.mjs";

test("90 percent requests checkpoint", () => {
  assert.deepEqual(
    decideTransition({
      state: "running",
      used: 0.90,
      prepareAt: 0.90,
      forceAt: 0.95,
      heartbeatFresh: true,
      processAlive: true,
      checkpoint: null,
    }).action,
    "request_handoff"
  );
});

test("fresh checkpointing worker is observed below force threshold", () => {
  assert.equal(
    decideTransition({
      state: "handoff_preparing",
      used: 0.93,
      prepareAt: 0.90,
      forceAt: 0.95,
      heartbeatFresh: true,
      processAlive: true,
      checkpoint: null,
    }).action,
    "observe"
  );
});

test("force threshold progresses with partial durable state", () => {
  assert.equal(
    decideTransition({
      state: "handoff_preparing",
      used: 0.95,
      prepareAt: 0.90,
      forceAt: 0.95,
      heartbeatFresh: true,
      processAlive: true,
      checkpoint: null,
    }).action,
    "force_handoff"
  );
});
```

- [ ] **Step 3: Implement pure transition planning**

`decideTransition` returns only:

```text
noop
request_handoff
observe
complete_handoff
force_handoff
recover_crash
enter_waiting_capacity
```

It must not execute TMUX or write files. All time and thresholds are injected.

- [ ] **Step 4: Implement side-effect execution**

`executeTransition` performs, in order:

1. write `mailbox/CONTROL.json`;
2. inject a control message through the active harness adapter;
3. validate checkpoint when present;
4. release old lease before spawning a successor;
5. stop old TMUX after checkpoint persistence;
6. refresh usage;
7. regenerate exact compatible chain excluding exhausted attempt cell;
8. create and acquire the next attempt;
9. start its TMUX worker with checkpoint path in the prompt;
10. append a transition event and notify mailbox.

On spawn failure, release the failed lease and retry another compatible
candidate or enter `waiting_capacity`. Never leave two active leases.

- [ ] **Step 5: Integrate the watcher**

After a successful usage collection, `usage-watcher` calls
`superviseActiveRuns({ now })`. While specialist runs exist, cap the collection
interval at 60 seconds. Generic runs remain unaffected.

- [ ] **Step 6: Run and commit**

```bash
node --test test/supervisor/checkpoint.test.mjs test/supervisor/controller.test.mjs test/usage/usage-watcher.test.mjs test/specialists/launcher.test.mjs
git add src/supervisor/checkpoint.mjs src/supervisor/controller.mjs src/specialists/launcher.mjs src/usage/usage-watcher.mjs test/supervisor/checkpoint.test.mjs test/supervisor/controller.test.mjs
git commit -m "feat(supervisor): hand off specialists at provider thresholds"
```

### Task 11: Add Durable Capacity Waits, Cancellation, and Reset Resumption

**Files:**

- Create: `src/supervisor/waits.mjs`
- Modify: `src/supervisor/controller.mjs`
- Modify: `src/cli.mjs`
- Modify: `src/runs/runs.mjs`
- Test: `test/supervisor/waits.test.mjs`
- Test: `test/cli-waits.test.mjs`

- [ ] **Step 1: Write failing wait tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  approveCapacityWait,
  cancelCapacityWait,
  listDueWaits,
} from "../../src/supervisor/waits.mjs";
import { loadState, runDir } from "../../src/runs/runs.mjs";

test("approved wait survives restart and becomes due", () => {
  approveCapacityWait({
    runId,
    nextResetAt: "2026-07-25T18:30:00Z",
    now: "2026-07-25T17:00:00Z",
  });
  assert.deepEqual(listDueWaits({ now: "2026-07-25T18:30:01Z" }), [runId]);
});

test("cancel wait preserves run and disables automatic resume", () => {
  cancelCapacityWait({ runId, reason: "human requested" });
  const state = loadState(runId);
  assert.equal(state.status, "waiting_decision");
  assert.equal(state.capacity.auto_resume, false);
  assert.equal(fs.existsSync(runDir(runId)), true);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/supervisor/waits.test.mjs
```

- [ ] **Step 3: Implement durable wait state**

Store under `STATE.json`:

```js
capacity: {
  blocked_candidates,
  next_reset_at,
  reset_confidence,
  auto_resume,
  resume_not_before,
  wait_cancelled,
  available_actions,
}
```

Waiting begins only after explicit `approveCapacityWait`. At due time, refresh
usage before resolving. If reset moved, atomically update the report. If
capacity is available, create a new attempt and notify the parent.

- [ ] **Step 4: Add CLI commands**

Implement:

```text
team-up runs capacity <run-id>
team-up runs wait-capacity <run-id>
team-up runs cancel-wait <run-id> --reason <text>
team-up runs recheck-capacity <run-id>
team-up runs cancel <run-id>
```

`cancel-wait` must never delete files or mark the full run cancelled.

- [ ] **Step 5: Restore waits after host restart**

Extend `runs resume` so it lists and reattaches due-wait supervision. A future
wait is left durable without spawning a worker. Add a test in which the process
is recreated from disk and resumes only after `resume_not_before`.

- [ ] **Step 6: Run and commit**

```bash
node --test test/supervisor/waits.test.mjs test/cli-waits.test.mjs test/runs/runs.test.mjs
git add src/supervisor/waits.mjs src/supervisor/controller.mjs src/cli.mjs src/runs/runs.mjs test/supervisor/waits.test.mjs test/cli-waits.test.mjs
git commit -m "feat(supervisor): persist cancellable capacity waits"
```

### Task 12: Integrate Starter Specialists and Complete End-to-End Verification

**Files:**

- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/specialists.md`
- Create: `docs/command-broker.md`
- Create: `test/integration/runtime-supervision.test.mjs`
- Modify: `/home/bbbee/projects/tasks/task-team-up-mvp/RESULT.md`

- [ ] **Step 1: Write the full fake-harness integration test**

Using temporary `TEAM_UP_HOME`, project, runs root, fake CLI, and fixture usage:

1. create `.team-up/commands.json` with fixed `project-test`;
2. install and approve Hannes;
3. prove the approval binds the command-policy checksum;
4. resolve only exact `frontier + max` cells with verified broker capability;
5. launch attempt 1 and prove no hard token-adapter gate remains;
6. invoke `project_test` through the MCP broker;
7. prove arbitrary shell/action calls fail;
8. raise the active provider window to 90%;
9. produce a typed checkpoint and heartbeat;
10. hand off to attempt 2 under the same run and specialist;
11. prove attempt 1 is stopped before attempt 2 acquires the lease;
12. exhaust the exact chain and assert normalized reset report;
13. approve wait, simulate restart, and resume after reset;
14. cancel another wait and prove the run remains preserved;
15. prove no high/medium/low model enters Hannes's frontier chain.

- [ ] **Step 2: Update documentation**

Document:

- explicit trusted-specialist threat model;
- best-effort filesystem/network isolation;
- command-policy file and approval binding;
- one common broker with adapter-specific shell denial;
- initially supported and unsupported harness adapters;
- advisory token budget migration;
- 90/95 handoff state machine;
- normalized reset schema;
- wait, cancel-wait, recheck, and recovery commands.

Do not claim that Cursor, Codex, Hermes, or OpenCode enforce the broker until
their adapters have passed conformance.

- [ ] **Step 3: Run all engine verification**

```bash
cd /home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up
npm test
bash test/runs/wait-mailbox.test.sh
node bin/team-up.mjs version
git diff --check 8e03733..HEAD
git status --short
```

Expected:

- all Node tests pass;
- shell mailbox test prints `wait-mailbox.test.sh OK`;
- version prints `0.1.0`;
- diff check is clean;
- engine worktree is clean after final documentation commit.

- [ ] **Step 4: Run real Claude adapter conformance**

Use a temporary fixture project containing a harmless `project-test` command:

```bash
node bin/team-up.mjs harness verify claude --fixture-project test/fixtures/harness-project
```

Expected:

```text
native_shell: denied
broker_tool: passed
status: verified
```

This may use a small amount of the Claude subscription. If authentication or
capacity is unavailable, record `BLOCKED` honestly; do not mark the adapter
verified and do not make Hannes eligible through it.

- [ ] **Step 5: Verify the o9k adapter remains compatible**

```bash
cd /home/bbbee/projects/o9k/.worktrees/team-up-adapter
TEAM_UP_BIN=/home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up/bin/team-up.mjs \
  node --test plugins/o9k-roster/scripts/*.test.mjs
node --test plugins/o9k-core/scripts/hosts/*.test.mjs
git diff --check main..HEAD
git status --short
```

Expected: 4 adapter tests and 36 host tests pass unless the implementation
adds explicit new adapter tests; all discovered tests must pass.

- [ ] **Step 6: Review every acceptance criterion**

Create a table in `/home/bbbee/projects/tasks/task-team-up-mvp/RESULT.md`
mapping all 13 design acceptance criteria to an exact test or command. Mark the
overall result `NOT READY` if any criterion fails or real command-broker
conformance is unverified.

- [ ] **Step 7: Commit documentation and integration test**

```bash
cd /home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up
git add README.md docs test/integration/runtime-supervision.test.mjs
git commit -m "docs: document supervised specialist runtime"
```

- [ ] **Step 8: Record final repository state**

```bash
for repo in \
  /home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up \
  /home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up-with-hannes \
  /home/bbbee/projects/tasks/task-team-up-mvp/repos/team-up-with-hugo \
  /home/bbbee/projects/o9k/.worktrees/team-up-adapter
do
  git -C "$repo" status --short --branch
  git -C "$repo" log -1 --oneline
  git -C "$repo" remote -v
done
```

Expected:

- all implementation repositories are clean;
- no new standalone repository has a remote yet;
- o9k remains on `feature/team-up-mvp`;
- live roster files were not modified.

## Final Review Checklist

- No specialist manifest contains a concrete model or provider.
- No resolver path changes tier automatically.
- Roster booleans cannot assert security capability.
- The broker exposes no arbitrary command string.
- Command policy is checksum-bound and snapshotted before worker access.
- Unsupported harnesses are filtered before chain creation.
- Token target is visibly advisory and cannot block launch.
- Reset times are ISO or explicit unknown, with raw provider data retained.
- A checkpointing worker is observed below the force threshold.
- Only one attempt owns the active lease.
- Capacity waiting requires approval and can be cancelled without data loss.
- Parent, watcher, controller, and worker responsibilities remain distinct.
- No push, publish, merge, remote creation, or live roster mutation occurred
  during implementation.
