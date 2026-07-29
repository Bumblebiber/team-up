# Terminal Worker TMUX Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically stop terminal worker TMUX sessions and reclaim workers that remain doubly inactive for 30 minutes plus a 10-minute grace period.

**Architecture:** `runs wait` performs immediate terminal cleanup through a small TMUX adapter. A separate GC module evaluates all durable run states using mailbox heartbeat plus TMUX window activity, records stale candidacy, and performs idempotent failure cleanup after grace. A generated user-systemd timer executes `team-up runs gc` every five minutes with absolute executable paths.

**Tech Stack:** Node.js ES modules, native `node:test`, TMUX CLI, user systemd, existing disk-first `STATE.json` and mailbox protocol.

---

## File Structure

- Create `src/runs/tmux.mjs`: TMUX liveness, activity, and best-effort stop adapter.
- Create `src/runs/gc.mjs`: pure GC decision function plus deterministic side-effect executor.
- Create `src/runs/gc-timer.mjs`: user-systemd unit rendering and installation.
- Modify `src/runs/runs.mjs`: all-state listing, terminal cleanup in `waitMailbox`, and `gc`/`gc-install` CLI handlers.
- Modify `test/runs/runs.test.mjs`: watcher-owned terminal cleanup regression tests.
- Create `test/runs/gc.test.mjs`: 30+10 policy, protected states, failure artifacts, idempotency, and dry-run tests.
- Create `test/runs/gc-timer.test.mjs`: absolute-path unit generation and installation tests.
- Modify `skills/roster/SKILL.md`: terminal cleanup and stale-watchdog protocol.

### Task 1: Immediate Watcher-Owned Terminal Cleanup

**Files:**
- Create: `src/runs/tmux.mjs`
- Modify: `src/runs/runs.mjs:394-445,777-796`
- Modify: `test/runs/runs.test.mjs`

- [ ] **Step 1: Write failing watcher cleanup tests**

Add `waitMailbox` to the imports in `test/runs/runs.test.mjs`, then add:

```js
test("waitMailbox stops worker tmux for every terminal outcome", withTempRuns(async () => {
  for (const status of ["done", "failed", "cancelled"]) {
    const state = createRun({
      cwd: "/tmp/p",
      role: "implementer",
      parent: { cli: "claude", attach: "manual" },
      worker: { cli: "codex", tmux: `worker-${status}` },
      prompt: "x",
    });
    setStatus(state.runId, "watching");
    if (status === "done") {
      atomicWriteText(path.join(runDir(state.runId), "mailbox", "RESULT.md"), "complete\n");
    }
    atomicWriteText(path.join(runDir(state.runId), "mailbox", "STATUS"), `${status}\n`);
    const stopped = [];

    const result = waitMailbox(state.runId, {
      ceilingSec: 1,
      stopTmux: session => {
        stopped.push(session);
        return true;
      },
    });

    assert.equal(result.classified.status, status);
    assert.deepEqual(stopped, [`worker-${status}`]);
  }
}));

test("waitMailbox keeps worker tmux for a human question", withTempRuns(async () => {
  const state = createRun({
    cwd: "/tmp/p",
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "worker-question" },
    prompt: "x",
  });
  setStatus(state.runId, "waiting_human");
  atomicWriteText(path.join(runDir(state.runId), "mailbox", "QUESTIONS.md"), "Need input\n");
  const stopped = [];

  const result = waitMailbox(state.runId, {
    ceilingSec: 1,
    stopTmux: session => stopped.push(session),
  });

  assert.equal(result.classified.status, "question");
  assert.deepEqual(stopped, []);
}));
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test test/runs/runs.test.mjs
```

Expected: FAIL because `waitMailbox` does not accept/use `stopTmux`.

- [ ] **Step 3: Add focused TMUX adapter**

Create `src/runs/tmux.mjs`:

```js
import { execFileSync } from "node:child_process";

export function inspectTmuxSession(session, { exec = execFileSync } = {}) {
  if (!session) return { exists: false, activityMs: null };
  try {
    const raw = exec(
      "tmux",
      ["display-message", "-p", "-t", session, "#{window_activity}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const seconds = Number(raw);
    return {
      exists: true,
      activityMs: Number.isFinite(seconds) ? seconds * 1000 : null,
    };
  } catch {
    return { exists: false, activityMs: null };
  }
}

export function stopTmuxSession(session, { exec = execFileSync } = {}) {
  if (!session) return false;
  try {
    exec("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Wire terminal cleanup into both `waitMailbox` return paths**

Import `stopTmuxSession` in `src/runs/runs.mjs`. Add:

```js
function cleanupTerminalWorker(state, classified, stopTmux) {
  const status = classified?.status || state?.status;
  if (!TERMINAL_RUN_STATUSES.has(status)) return false;
  const session = state?.worker?.tmux;
  if (!session) return false;
  stopTmux(session);
  return true;
}
```

Change signature:

```js
export function waitMailbox(runId, {
  ceilingSec = 3600,
  stopTmux = stopTmuxSession,
} = {}) {
```

Immediately before each return from the pre-wait terminal branch and final
post-wait branch, call:

```js
cleanupTerminalWorker(resolved.state, resolved.classified, stopTmux);
```

Do not call cleanup for `question`.

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```bash
node --test test/runs/runs.test.mjs test/runs/resume-reconcile.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 6: Commit immediate cleanup**

```bash
git add src/runs/tmux.mjs src/runs/runs.mjs test/runs/runs.test.mjs
git commit -m "fix: stop terminal worker tmux sessions"
```

### Task 2: Deterministic 30+10 Garbage Collector

**Files:**
- Create: `src/runs/gc.mjs`
- Modify: `src/runs/runs.mjs:568-584`
- Create: `test/runs/gc.test.mjs`

- [ ] **Step 1: Write failing pure policy tests**

Create `test/runs/gc.test.mjs` with a table covering policy:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateGcAction,
  gcRuns,
  IDLE_MS,
  GRACE_MS,
} from "../../src/runs/gc.mjs";
import {
  createRun,
  loadState,
  runDir,
  saveState,
  setStatus,
} from "../../src/runs/runs.mjs";

const NOW = Date.parse("2026-07-28T13:00:00.000Z");

function baseState(status = "watching") {
  return {
    runId: "r1",
    status,
    worker: { tmux: "worker-r1" },
    cleanup: {},
  };
}

test("either fresh signal prevents stale candidacy", () => {
  for (const [heartbeatMs, activityMs] of [
    [NOW - IDLE_MS + 1, NOW - IDLE_MS - 1],
    [NOW - IDLE_MS - 1, NOW - IDLE_MS + 1],
  ]) {
    assert.equal(evaluateGcAction({
      state: baseState(),
      nowMs: NOW,
      heartbeatMs,
      tmux: { exists: true, activityMs },
    }).kind, "noop");
  }
});

test("dual 30 minute staleness starts grace before kill", () => {
  const first = evaluateGcAction({
    state: baseState(),
    nowMs: NOW,
    heartbeatMs: NOW - IDLE_MS - 1,
    tmux: { exists: true, activityMs: NOW - IDLE_MS - 1 },
  });
  assert.equal(first.kind, "mark_stale");

  const candidate = baseState();
  candidate.cleanup.stale_detected_at = new Date(NOW - GRACE_MS + 1).toISOString();
  assert.equal(evaluateGcAction({
    state: candidate,
    nowMs: NOW,
    heartbeatMs: NOW - IDLE_MS - 1,
    tmux: { exists: true, activityMs: NOW - IDLE_MS - 1 },
  }).kind, "grace");
});

test("continued dual staleness through grace fails worker", () => {
  const state = baseState();
  state.cleanup.stale_detected_at = new Date(NOW - GRACE_MS).toISOString();
  assert.equal(evaluateGcAction({
    state,
    nowMs: NOW,
    heartbeatMs: NOW - IDLE_MS - 1,
    tmux: { exists: true, activityMs: NOW - IDLE_MS - 1 },
  }).kind, "fail_stale");
});

test("protected states never stale-kill", () => {
  for (const status of [
    "waiting_human",
    "waiting_capacity",
    "waiting_decision",
    "handoff_preparing",
    "handing_off",
  ]) {
    assert.equal(evaluateGcAction({
      state: baseState(status),
      nowMs: NOW,
      heartbeatMs: null,
      tmux: { exists: true, activityMs: null },
    }).kind, "skip");
  }
});
```

- [ ] **Step 2: Run policy tests and verify RED**

Run:

```bash
node --test test/runs/gc.test.mjs
```

Expected: FAIL with module-not-found for `src/runs/gc.mjs`.

- [ ] **Step 3: Implement pure decision function**

Create `src/runs/gc.mjs` with:

```js
import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteJson,
  atomicWriteText,
  listAllStates,
  loadState,
  mailboxDir,
  updateState,
} from "./runs.mjs";
import { inspectTmuxSession, stopTmuxSession } from "./tmux.mjs";
import { releaseAttemptLease } from "../supervisor/attempts.mjs";

export const IDLE_MS = 30 * 60 * 1000;
export const GRACE_MS = 10 * 60 * 1000;
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const ACTIVE = new Set(["starting", "watching"]);
const PROTECTED = new Set([
  "waiting_human",
  "waiting_capacity",
  "waiting_decision",
  "handoff_preparing",
  "handing_off",
]);

function isFresh(timestamp, nowMs, idleMs) {
  return Number.isFinite(timestamp) && nowMs - timestamp < idleMs;
}

export function evaluateGcAction({
  state,
  nowMs,
  heartbeatMs,
  tmux,
  idleMs = IDLE_MS,
  graceMs = GRACE_MS,
}) {
  if (TERMINAL.has(state.status)) {
    return tmux.exists ? { kind: "kill_terminal" } : { kind: "skip" };
  }
  if (PROTECTED.has(state.status) || !ACTIVE.has(state.status)) {
    return { kind: "skip" };
  }
  if (!tmux.exists) return { kind: "skip" };
  if (
    isFresh(heartbeatMs, nowMs, idleMs) ||
    isFresh(tmux.activityMs, nowMs, idleMs)
  ) {
    return state.cleanup?.stale_detected_at
      ? { kind: "clear_stale" }
      : { kind: "noop" };
  }
  const detectedMs = Date.parse(state.cleanup?.stale_detected_at || "");
  if (!Number.isFinite(detectedMs)) return { kind: "mark_stale" };
  if (nowMs - detectedMs < graceMs) return { kind: "grace" };
  return { kind: "fail_stale" };
}
```

- [ ] **Step 4: Export all-state enumeration without weakening active callers**

In `src/runs/runs.mjs`, replace the body split with:

```js
export function listAllStates({ onCorrupt } = {}) {
  const root = runsRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith(".")) continue;
    try {
      const state = loadState(name);
      if (state) out.push(state);
    } catch (error) {
      if (typeof onCorrupt === "function") onCorrupt(name, error);
      else console.error(`skip corrupt run ${name}: ${error.message}`);
    }
  }
  return out;
}

export function listActiveStates(options = {}) {
  return listAllStates(options).filter(
    state => !TERMINAL_RUN_STATUSES.has(state.status),
  );
}
```

- [ ] **Step 5: Add failing side-effect tests**

Extend `test/runs/gc.test.mjs`:

```js
function withTempRuns(fn) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-gc-"));
    const previous = process.env.TEAM_UP_RUNS;
    process.env.TEAM_UP_RUNS = root;
    try {
      await fn(root);
    } finally {
      if (previous === undefined) delete process.env.TEAM_UP_RUNS;
      else process.env.TEAM_UP_RUNS = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function createGcFixture({ typed = false, status = "watching" } = {}) {
  const state = createRun({
    cwd: "/tmp/project",
    role: "implementer",
    parent: { cli: "claude", attach: "manual" },
    worker: { cli: "codex", tmux: "worker-gc" },
    prompt: "test",
    ...(typed ? { result_protocol: "RESULT.json" } : {}),
    now: new Date("2026-07-28T12:00:00.000Z"),
  });
  setStatus(state.runId, status);
  return loadState(state.runId);
}

const staleDeps = {
  now: new Date(NOW),
  heartbeatFor: () => NOW - IDLE_MS - 1,
  inspectTmux: () => ({ exists: true, activityMs: NOW - IDLE_MS - 1 }),
};

test("gc records stale candidate and fresh activity clears it", withTempRuns(async () => {
  const state = createGcFixture();
  const stopped = [];
  gcRuns({
    ...staleDeps,
    states: [state],
    stopTmux: session => stopped.push(session),
    releaseLease: () => assert.fail("must not release during grace"),
  });
  assert.equal(
    loadState(state.runId).cleanup.stale_detected_at,
    new Date(NOW).toISOString(),
  );
  assert.deepEqual(stopped, []);

  gcRuns({
    now: new Date(NOW + 60_000),
    states: [loadState(state.runId)],
    heartbeatFor: () => NOW + 30_000,
    inspectTmux: () => ({ exists: true, activityMs: NOW - IDLE_MS - 1 }),
    stopTmux: session => stopped.push(session),
    releaseLease: () => assert.fail("must not release after fresh activity"),
  });
  assert.equal(loadState(state.runId).cleanup.stale_detected_at, undefined);
}));

test("gc fails typed worker after 30+10 and cleans lease before tmux", withTempRuns(async () => {
  const state = createGcFixture({ typed: true });
  const candidate = loadState(state.runId);
  candidate.cleanup = {
    stale_detected_at: new Date(NOW - GRACE_MS).toISOString(),
  };
  candidate.current_attempt_id = "attempt-1";
  saveState(candidate);
  const effects = [];

  const report = gcRuns({
    ...staleDeps,
    states: [loadState(state.runId)],
    releaseLease: input => effects.push(["release", input]),
    stopTmux: session => effects.push(["stop", session]),
  });

  assert.equal(report.runs[0].action, "fail_stale");
  assert.equal(loadState(state.runId).status, "failed");
  assert.equal(
    fs.readFileSync(path.join(runDir(state.runId), "mailbox", "STATUS"), "utf8").trim(),
    "failed",
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(runDir(state.runId), "mailbox", "RESULT.json"), "utf8")),
    {
      schema: "team-up.result/v1",
      status: "failed",
      summary: "worker_stale_timeout",
    },
  );
  assert.deepEqual(effects, [
    ["release", {
      runId: state.runId,
      attemptId: "attempt-1",
      reason: "worker_stale_timeout",
      now: new Date(NOW).toISOString(),
    }],
    ["stop", "worker-gc"],
  ]);
}));

test("gc terminal cleanup is idempotent and dry-run never mutates", withTempRuns(async () => {
  const terminal = createGcFixture({ status: "done" });
  const stopped = [];
  gcRuns({
    now: new Date(NOW),
    states: [terminal],
    heartbeatFor: () => null,
    inspectTmux: () => ({ exists: true, activityMs: null }),
    stopTmux: session => stopped.push(session),
  });
  assert.deepEqual(stopped, ["worker-gc"]);

  const active = createGcFixture();
  const before = JSON.stringify(loadState(active.runId));
  const report = gcRuns({
    ...staleDeps,
    states: [active],
    dryRun: true,
    stopTmux: () => assert.fail("dry-run must not stop"),
    releaseLease: () => assert.fail("dry-run must not release"),
  });
  assert.equal(report.runs[0].action, "mark_stale");
  assert.equal(JSON.stringify(loadState(active.runId)), before);
});
```

- [ ] **Step 6: Run side-effect tests and verify RED**

Run:

```bash
node --test test/runs/gc.test.mjs
```

Expected: policy tests PASS; side-effect tests FAIL because `gcRuns` is missing.

- [ ] **Step 7: Implement GC executor**

Add helpers to `src/runs/gc.mjs`:

```js
function heartbeatForRun(runId) {
  try {
    const raw = fs.readFileSync(path.join(mailboxDir(runId), "HEARTBEAT"), "utf8").trim();
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function setStaleDetected(runId, nowIso) {
  return updateState(runId, state => {
    state.cleanup = { ...(state.cleanup || {}), stale_detected_at: nowIso };
    return state;
  });
}

function clearStaleDetected(runId) {
  return updateState(runId, state => {
    if (!state.cleanup?.stale_detected_at) return undefined;
    delete state.cleanup.stale_detected_at;
    return state;
  });
}

function persistStaleFailure(state, nowIso) {
  const mb = mailboxDir(state.runId);
  if (state.result_protocol === "RESULT.json") {
    atomicWriteJson(path.join(mb, "RESULT.json"), {
      schema: "team-up.result/v1",
      status: "failed",
      summary: "worker_stale_timeout",
    });
  } else {
    atomicWriteText(path.join(mb, "RESULT.md"), "worker_stale_timeout\n");
  }
  atomicWriteText(path.join(mb, "STATUS"), "failed\n");
  return updateState(state.runId, latest => {
    latest.status = "failed";
    latest.cleanup = {
      ...(latest.cleanup || {}),
      stale_failed_at: nowIso,
      stale_reason: "worker_stale_timeout",
    };
    return latest;
  });
}
```

Implement:

```js
export function gcRuns({
  now = new Date(),
  states = null,
  heartbeatFor = heartbeatForRun,
  inspectTmux = inspectTmuxSession,
  stopTmux = stopTmuxSession,
  releaseLease = releaseAttemptLease,
  dryRun = false,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("gc requires valid now");
  const nowIso = new Date(nowMs).toISOString();
  const input = states || listAllStates();
  const report = { at: nowIso, dryRun, runs: [] };

  for (const snapshot of input) {
    const state = loadState(snapshot.runId) || snapshot;
    const tmux = inspectTmux(state.worker?.tmux || null);
    const decision = evaluateGcAction({
      state,
      nowMs,
      heartbeatMs: heartbeatFor(state.runId),
      tmux,
    });
    report.runs.push({ runId: state.runId, action: decision.kind });
    if (dryRun) continue;

    if (decision.kind === "kill_terminal") {
      stopTmux(state.worker.tmux);
      continue;
    }
    if (decision.kind === "mark_stale") {
      setStaleDetected(state.runId, nowIso);
      continue;
    }
    if (decision.kind === "clear_stale") {
      clearStaleDetected(state.runId);
      continue;
    }
    if (decision.kind !== "fail_stale") continue;

    const failed = persistStaleFailure(state, nowIso);
    if (failed.current_attempt_id) {
      try {
        releaseLease({
          runId: failed.runId,
          attemptId: failed.current_attempt_id,
          reason: "worker_stale_timeout",
          now: nowIso,
        });
      } catch (error) {
        report.runs.at(-1).leaseError = String(error.message || error);
      }
    }
    try {
      stopTmux(failed.worker?.tmux);
    } catch (error) {
      report.runs.at(-1).tmuxError = String(error.message || error);
    }
  }

  return report;
}
```

- [ ] **Step 8: Run GC tests and verify GREEN**

Run:

```bash
node --test test/runs/gc.test.mjs test/runs/runs.test.mjs test/runs/resume-reconcile.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 9: Commit GC policy**

```bash
git add src/runs/gc.mjs src/runs/runs.mjs test/runs/gc.test.mjs
git commit -m "feat: reclaim stale team-up workers"
```

### Task 3: GC CLI and Five-Minute User Timer

**Files:**
- Create: `src/runs/gc-timer.mjs`
- Modify: `src/runs/runs.mjs:840-1080`
- Create: `test/runs/gc-timer.test.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Write failing timer rendering/install tests**

Create `test/runs/gc-timer.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installGcTimer, renderGcUnits } from "../../src/runs/gc-timer.mjs";

test("renderGcUnits uses absolute executables and five minute cadence", () => {
  const units = renderGcUnits({
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/team-up/bin/team-up.mjs",
  });
  assert.match(units.service, /ExecStart="\/opt\/node\/bin\/node" "\/opt\/team-up\/bin\/team-up\.mjs" runs gc/);
  assert.match(units.timer, /OnBootSec=5min/);
  assert.match(units.timer, /OnUnitActiveSec=5min/);
  assert.match(units.timer, /Persistent=true/);
});

test("installGcTimer writes units then enables timer", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-gc-timer-"));
  const calls = [];
  try {
    const result = installGcTimer({
      home,
      nodePath: "/opt/node/bin/node",
      cliPath: "/opt/team-up/bin/team-up.mjs",
      exec: (bin, args) => calls.push([bin, args]),
    });
    assert.equal(fs.existsSync(result.servicePath), true);
    assert.equal(fs.existsSync(result.timerPath), true);
    assert.deepEqual(calls, [
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "--now", "team-up-gc.timer"]],
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run timer tests and verify RED**

Run:

```bash
node --test test/runs/gc-timer.test.mjs
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement timer renderer and installer**

Create `src/runs/gc-timer.mjs`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function unitQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderGcUnits({ nodePath, cliPath }) {
  return {
    service: `[Unit]
Description=team-up terminal and stale worker cleanup

[Service]
Type=oneshot
ExecStart=${unitQuote(nodePath)} ${unitQuote(cliPath)} runs gc
`,
    timer: `[Unit]
Description=Run team-up worker cleanup every five minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
Persistent=true
Unit=team-up-gc.service

[Install]
WantedBy=timers.target
`,
  };
}

export function installGcTimer({
  home = os.homedir(),
  nodePath = process.execPath,
  cliPath = fileURLToPath(new URL("../../bin/team-up.mjs", import.meta.url)),
  exec = execFileSync,
} = {}) {
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(cliPath)) {
    throw new Error("gc timer requires absolute executable paths");
  }
  const dir = path.join(home, ".config", "systemd", "user");
  fs.mkdirSync(dir, { recursive: true });
  const servicePath = path.join(dir, "team-up-gc.service");
  const timerPath = path.join(dir, "team-up-gc.timer");
  const units = renderGcUnits({ nodePath, cliPath });
  fs.writeFileSync(servicePath, units.service);
  fs.writeFileSync(timerPath, units.timer);
  exec("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  exec("systemctl", ["--user", "enable", "--now", "team-up-gc.timer"], { stdio: "ignore" });
  return { servicePath, timerPath };
}
```

- [ ] **Step 4: Add GC CLI handlers**

In `src/runs/runs.mjs`, add async handlers:

```js
async function cmdGc(args) {
  const dryRun = args.includes("--dry-run");
  const { gcRuns } = await import("./gc.mjs");
  const report = gcRuns({ dryRun });
  for (const item of report.runs) {
    console.log(`runId: ${item.runId} action: ${item.action}`);
  }
}

async function cmdGcInstall() {
  const { installGcTimer } = await import("./gc-timer.mjs");
  const result = installGcTimer();
  console.log(`service: ${result.servicePath}`);
  console.log(`timer: ${result.timerPath}`);
}
```

Register `gc` and `gc-install` in `HANDLERS`. Convert `main` to:

```js
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const handler = HANDLERS[cmd];
  if (!handler) {
    console.error(`usage: runs.mjs <${Object.keys(HANDLERS).join("|")}> [options]`);
    process.exitCode = 1;
    return;
  }
  await handler(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
```

- [ ] **Step 5: Verify CLI behavior**

Add a CLI regression in `test/cli.test.mjs` invoking:

```js
const code = await runCli(["runs", "gc", "--dry-run"], {
  out: line => output.push(line),
  err: line => errors.push(line),
});
assert.equal(code, 0);
assert.deepEqual(errors, []);
```

Use a temporary `TEAM_UP_RUNS` directory so live runs are never inspected.

- [ ] **Step 6: Run timer and CLI tests and verify GREEN**

Run:

```bash
node --test test/runs/gc-timer.test.mjs test/cli.test.mjs test/runs/gc.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 7: Commit CLI and timer**

```bash
git add src/runs/gc-timer.mjs src/runs/runs.mjs test/runs/gc-timer.test.mjs test/cli.test.mjs
git commit -m "feat: schedule team-up worker cleanup"
```

### Task 4: Protocol Documentation, Full Verification, and Local Enablement

**Files:**
- Modify: `skills/roster/SKILL.md:137-160`

- [ ] **Step 1: Document cleanup ownership and protected states**

After roster protocol step 5, add:

```markdown
Terminal worker cleanup is automatic: `runs wait` stops worker TMUX after
`done|failed|cancelled`, and the five-minute `runs gc` timer catches missed
cleanup. Active `starting|watching` workers become stale candidates only when
both mailbox HEARTBEAT and TMUX window activity are older than 30 minutes; they
are failed and stopped only after another 10 minutes without either signal.
Human questions, capacity/decision waits, and handoff states are never
stale-killed.
```

- [ ] **Step 2: Run focused verification**

Run:

```bash
node --test \
  test/runs/runs.test.mjs \
  test/runs/resume-reconcile.test.mjs \
  test/runs/gc.test.mjs \
  test/runs/gc-timer.test.mjs \
  test/cli.test.mjs
```

Expected: all tests PASS with zero failures.

- [ ] **Step 3: Run complete suite**

Run:

```bash
npm test
```

Expected: all tests PASS with zero failures.

- [ ] **Step 4: Verify live dry-run before enabling timer**

Run:

```bash
team-up runs gc --dry-run
```

Expected: reports intended action per run and performs no state or TMUX mutation.

- [ ] **Step 5: Install and verify user timer**

Run:

```bash
team-up runs gc-install
systemctl --user is-enabled team-up-gc.timer
systemctl --user is-active team-up-gc.timer
systemctl --user list-timers team-up-gc.timer --no-pager
```

Expected: both status commands print `enabled` and `active`; timer list shows
next execution within five minutes.

- [ ] **Step 6: Commit documentation**

```bash
git add skills/roster/SKILL.md
git commit -m "docs: document worker cleanup watchdog"
```

- [ ] **Step 7: Final integrity check**

Run:

```bash
git status --short
git log -6 --oneline
```

Expected: clean worktree and four implementation commits after design/plan docs.
