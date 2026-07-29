<!-- o9k-provenance
who: codex:gpt-5
when: 2026-07-26T12:47:20Z
why: Create the TDD implementation plan for approved supervisor startup and notification handling
trigger: User approved the written supervisor startup notification specification
host: codex
-->
# Supervisor Startup and Notification Implementation Plan

> **SUPERSEDED 2026-07-29.** Do not implement this plan. Tasks 1–8 were built on
> `feature/supervisor-startup-notification` (deleted; last commit `677b23d`,
> restorable from the reflog) and the branch was rejected as NOT_READY: only one
> of five CLIs ever got a startup classifier, and the readiness marker this plan
> relies on — `→ Add a follow-up` for cursor-agent — is provably wrong. It is the
> input-box placeholder and appears while the agent is working as well as when it
> is idle; see `test/fixtures/panes/cursor-agent/working-followup-placeholder.txt`.
>
> Replaced by adaptive pane observation, which polls the pane and the mailbox and
> lets a model judge a stalled screen instead of matching per-CLI strings:
> `docs/superpowers/specs/2026-07-28-adaptive-pane-observation-design.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent pre-model harness prompts and completed workers from silently trapping the supervisor by certifying real startup readiness and delivering durable terminal events through a wake-capable parent route.

**Architecture:** Harness adapters classify bounded startup snapshots; a generic observer owns TMUX capture, liveness, deadline, and state transitions. The run registry writes questions and stable events atomically, while a separate notifier delivers at-least-once through TMUX, configured argv, or an embedded host callback. Roster and specialist starts share the observer, and supervised dispatch fails before worker creation when no parent route can wake the supervisor.

**Tech Stack:** Node.js ES modules, native `node:test`, JSON/JSONL mailbox state, TMUX argv execution, existing run registry/roster/supervisor modules.

---

## Execution Context

Use a dedicated worktree based on current `main`:

```bash
cd /home/bbbee/projects/team-up
git worktree add .worktrees/supervisor-startup-notification \
  -b feature/supervisor-startup-notification
cd .worktrees/supervisor-startup-notification
npm install
npm test
```

Read the approved design first:

```bash
sed -n '1,340p' \
  docs/superpowers/specs/2026-07-26-supervisor-startup-notification-design.md
```

Do not touch the capability-pool worktree or live run mailboxes. Use
`TEAM_UP_RUNS` temporary directories in every test.

## Target File Structure

```text
src/harness/
  cursor-startup.mjs # exact Cursor pre-model classification
  startup.mjs        # bounded generic observer
src/runs/
  notifications.mjs  # stable events, outbox, route validation and delivery
test/harness/
  cursor-startup.test.mjs
  startup.test.mjs
test/runs/
  notifications.test.mjs
test/roster/
  startup.test.mjs
test/integration/
  supervisor-notification.test.mjs
```

Modify:

```text
src/harness/registry.mjs
src/roster/command.mjs
src/roster/roster.mjs
src/runs/runs.mjs
src/supervisor/start.mjs
test/harness/registry.test.mjs
test/runs/runs.test.mjs
test/integration/production-entrypoint.test.mjs
docs/MULTI-AGENT.md
```

### Task 1: Exact Cursor Startup Classification

**Files:**

- Create: `src/harness/cursor-startup.mjs`
- Modify: `src/harness/registry.mjs`
- Create: `test/harness/cursor-startup.test.mjs`
- Modify: `test/harness/registry.test.mjs`

- [ ] **Step 1: Write failing classifier tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { classifyCursorStartup }
  from "../../src/harness/cursor-startup.mjs";

test("Cursor login preserves the joined URL", () => {
  const snapshot = [
    " Signing in",
    " If your browser didn't open, click this link to log in:",
    "https://cursor.com/loginDeepControl?challenge=abc_123",
    "&uuid=d5be3b42-a57d-4829-868e-2611d77e8378&mode=login",
    " Press q to show a QR code to log in from another device",
  ].join("\n");
  const result = classifyCursorStartup(snapshot);
  assert.equal(result.kind, "auth");
  assert.equal(result.evidence.url,
    "https://cursor.com/loginDeepControl?challenge=abc_123&uuid=" +
    "d5be3b42-a57d-4829-868e-2611d77e8378&mode=login");
  assert.match(result.question, /Open this Cursor login URL/);
});

test("Cursor ready marker is explicit", () => {
  assert.deepEqual(classifyCursorStartup([
    "Cursor Agent", "→ Add a follow-up", "Cursor Grok 4.5 High",
  ].join("\n")), { status: "ready" });
});

test("unrelated authentication prose is not a blocker", () => {
  assert.equal(classifyCursorStartup(
    "Review authentication handling in src/login.mjs"
  ), null);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
node --test test/harness/cursor-startup.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement exact structural matching**

```js
function compactUrl(snapshot) {
  const start = snapshot.indexOf("https://cursor.com/loginDeepControl?");
  if (start < 0) return null;
  const tail = snapshot.slice(start);
  const lines = tail.split(/\r?\n/);
  let url = "";
  for (const line of lines) {
    const part = line.trim();
    if (!part) break;
    if (url && /^(Press |Cursor Agent|Tip:)/.test(part)) break;
    url += part;
  }
  return url.startsWith("https://cursor.com/loginDeepControl?") ? url : null;
}

export function classifyCursorStartup(snapshot = "") {
  const url = compactUrl(snapshot);
  if (snapshot.includes("Signing in") && url) {
    return {
      kind: "auth",
      question: `Open this Cursor login URL, complete sign-in, then answer ready:\n${url}`,
      evidence: { url, prompt: "Cursor CLI sign-in required" },
    };
  }
  if (/Press any key to log in/i.test(snapshot)) {
    return {
      kind: "auth",
      question: "Cursor CLI login is required. Attach to the worker and continue login.",
      evidence: { prompt: "Press any key to log in" },
    };
  }
  if (/trust this workspace/i.test(snapshot)) {
    return {
      kind: "trust",
      question: "Cursor requires a human workspace-trust decision.",
      evidence: { prompt: "Cursor workspace trust required" },
    };
  }
  if (snapshot.includes("Cursor Agent") &&
      snapshot.includes("→ Add a follow-up")) {
    return { status: "ready" };
  }
  return null;
}
```

In `src/harness/registry.mjs`, keep startup classification separate from
runtime capability eligibility:

```js
import { classifyCursorStartup } from "./cursor-startup.mjs";

const STARTUP_CLASSIFIERS = Object.freeze({
  cursor: classifyCursorStartup,
});

export function getStartupClassifier(cli) {
  return STARTUP_CLASSIFIERS[cli] ?? null;
}
```

- [ ] **Step 4: Verify and commit**

```bash
node --test test/harness/cursor-startup.test.mjs \
  test/harness/registry.test.mjs
git add src/harness/cursor-startup.mjs src/harness/registry.mjs \
  test/harness/cursor-startup.test.mjs test/harness/registry.test.mjs
git commit -m "feat: classify Cursor startup states"
```

Expected: focused tests PASS.

### Task 2: Bounded Harness Startup Observer

**Files:**

- Create: `src/harness/startup.mjs`
- Create: `test/harness/startup.test.mjs`

- [ ] **Step 1: Write failing observer tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { observeHarnessStartup } from "../../src/harness/startup.mjs";

test("observer returns a classified blocker", () => {
  const snapshots = ["", "Signing in\nhttps://cursor.com/loginDeepControl?x=1"];
  const result = observeHarnessStartup({
    session: "worker",
    classifier: (text) => text.includes("Signing in")
      ? { kind: "auth", question: "login", evidence: { prompt: "login" } }
      : null,
    capture: () => snapshots.shift() ?? snapshots.at(-1),
    sessionExists: () => true,
    sleep: () => {},
    now: sequenceClock([0, 1, 2]),
    timeoutMs: 10,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.blocker.kind, "auth");
});

test("observer fails when the pane dies before readiness", () => {
  const result = observeHarnessStartup({
    session: "worker", classifier: () => null, capture: () => "",
    sessionExists: () => false, sleep: () => {},
    now: sequenceClock([0, 1]), timeoutMs: 10,
  });
  assert.deepEqual(result, {
    status: "failed", reason: "worker exited before startup readiness",
    snapshot: "",
  });
});

test("observer requires explicit readiness and fails at deadline", () => {
  const result = observeHarnessStartup({
    session: "worker", classifier: () => null, capture: () => "some output",
    sessionExists: () => true, sleep: () => {},
    now: sequenceClock([0, 11]), timeoutMs: 10,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "startup readiness deadline exceeded");
});

function sequenceClock(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
```

- [ ] **Step 2: Run and verify RED**

```bash
node --test test/harness/startup.test.mjs
```

Expected: missing module failure.

- [ ] **Step 3: Implement condition-based observation**

```js
import { execFileSync } from "node:child_process";

export function captureJoinedPane(session) {
  return execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", session], {
    encoding: "utf8",
  });
}

export function tmuxSessionExists(session) {
  try {
    execFileSync("tmux", ["has-session", "-t", session], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function observeHarnessStartup({
  session,
  classifier,
  capture = captureJoinedPane,
  sessionExists = tmuxSessionExists,
  sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  now = Date.now,
  timeoutMs = 30_000,
  intervalMs = 250,
}) {
  if (typeof classifier !== "function") {
    return { status: "failed", reason: "startup classifier unavailable", snapshot: "" };
  }
  const deadline = now() + timeoutMs;
  let snapshot = "";
  while (now() <= deadline) {
    if (!sessionExists(session)) {
      return { status: "failed",
        reason: "worker exited before startup readiness", snapshot };
    }
    snapshot = capture(session) || "";
    const classified = classifier(snapshot);
    if (classified?.status === "ready") {
      return { status: "ready", snapshot };
    }
    if (classified?.kind) {
      return { status: "blocked", blocker: classified, snapshot };
    }
    sleep(intervalMs);
  }
  return {
    status: "failed",
    reason: "startup readiness deadline exceeded",
    snapshot: snapshot.slice(-4000),
  };
}
```

- [ ] **Step 4: Verify and commit**

```bash
node --test test/harness/startup.test.mjs
git add src/harness/startup.mjs test/harness/startup.test.mjs
git commit -m "feat: observe harness startup readiness"
```

Expected: all observer tests PASS.

### Task 3: Truthful Run Linking and Atomic Questions

**Files:**

- Modify: `src/runs/runs.mjs`
- Modify: `test/runs/runs.test.mjs`

- [ ] **Step 1: Replace the old linking regression**

```js
test("linkDispatchToRun links tmux but remains starting", withTempRuns(async () => {
  const state = createRun({
    cwd: "/tmp/project", role: "implementer",
    parent: { cli: "codex", attach: "manual" },
    worker: { cli: "cursor", model: "grok-4.5-high" },
    prompt: "work",
  });
  assert.equal(linkDispatchToRun(state.runId, "team-up-worker"), true);
  const linked = loadState(state.runId);
  assert.equal(linked.worker.tmux, "team-up-worker");
  assert.equal(linked.status, "starting");
  assert.equal(fs.readFileSync(path.join(
    runDir(state.runId), "mailbox", "STATUS"), "utf8").trim(), "starting");
}));

test("writeRunQuestion makes question durable before status", withTempRuns(async () => {
  const state = createRun({
    cwd: "/tmp/project", role: "implementer",
    parent: { cli: "codex", attach: "manual" },
    worker: { cli: "cursor", model: "grok-4.5-high" },
    prompt: "work",
  });
  const writes = [];
  writeRunQuestion(state.runId, {
    question: "Open https://cursor.example/login",
    kind: "auth",
    evidence: { url: "https://cursor.example/login" },
  }, {
    writeText: (file, text) => {
      writes.push(path.basename(file));
      fs.writeFileSync(file, text);
    },
  });
  assert.deepEqual(writes.slice(-2), ["QUESTIONS.md", "STATUS"]);
  assert.equal(loadState(state.runId).status, "waiting_human");
  assert.equal(classifyMailbox(state.runId).status, "question");
}));
```

The mailbox starts as `watching` for backward-compatible worker protocol, but
authoritative `STATE.status` stays `starting` until observer certification.

- [ ] **Step 2: Run and verify RED**

```bash
node --test test/runs/runs.test.mjs
```

Expected: old assertion reports `watching`, and `writeRunQuestion` is absent.

- [ ] **Step 3: Implement narrow state APIs**

```js
export function linkDispatchToRun(runId, session) {
  if (!runId) return false;
  const latest = updateState(runId, (state) => {
    state.worker = { ...(state.worker || {}), tmux: session };
    state.watcher = {
      ...(state.watcher || { kind: "internal_subagent" }),
      attached: true,
    };
    return state;
  });
  return Boolean(latest);
}

export function markRunWatching(runId) {
  return setStatus(runId, "watching");
}

export function writeRunQuestion(runId, {
  question, kind = "interactive", evidence = {},
}, { writeText = atomicWriteText } = {}) {
  const state = loadState(runId);
  if (!state) throw new Error(`unknown run ${runId}`);
  const body = [
    `# Human action required: ${kind}`,
    "",
    question.trim(),
    "",
    "```json",
    JSON.stringify(evidence, null, 2),
    "```",
  ].join("\n");
  writeText(path.join(mailboxDir(runId), "QUESTIONS.md"), body);
  updateState(runId, (latest) => {
    latest.status = "waiting_human";
    latest.startup_blocker = { kind, evidence };
    return latest;
  });
  writeText(path.join(mailboxDir(runId), "STATUS"), "waiting_human");
  return loadState(runId);
}

export function failRunStartup(runId, reason, snapshot = "") {
  updateState(runId, (state) => {
    state.status = "failed";
    state.last_start_error = reason;
    state.startup_diagnostic = snapshot.slice(-4000);
    return state;
  });
  atomicWriteText(path.join(mailboxDir(runId), "RESULT.md"),
    `Startup failed: ${reason}`);
  atomicWriteText(path.join(mailboxDir(runId), "STATUS"), "failed");
  return loadState(runId);
}
```

- [ ] **Step 4: Verify and commit**

```bash
node --test test/runs/runs.test.mjs
git add src/runs/runs.mjs test/runs/runs.test.mjs
git commit -m "fix: keep run state truthful during startup"
```

Expected: run tests PASS.

### Task 4: Stable Notification Events and Outbox

**Files:**

- Create: `src/runs/notifications.mjs`
- Create: `test/runs/notifications.test.mjs`
- Modify: `src/runs/runs.mjs`

- [ ] **Step 1: Write failing route and delivery tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveNotificationRoute, enqueueRunEvent, deliverPendingEvents,
} from "../../src/runs/notifications.mjs";

test("tmux parent is wake-capable", () => {
  assert.deepEqual(resolveNotificationRoute({
    attach: "tmux", tmux: "parent-session",
  }), { kind: "tmux", session: "parent-session" });
});

test("manual parent without notifier is rejected", () => {
  assert.throws(() => resolveNotificationRoute({
    attach: "manual",
  }, { required: true }), /PARENT_NOTIFICATION_UNAVAILABLE/);
});

test("event id is stable and successful delivery is marked", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-events-"));
  const state = { runId: "r1", _stateRevision: 7,
    parent: { notify: { kind: "tmux", session: "parent" } } };
  const first = enqueueRunEvent({
    state, status: "done", summary: "complete", mailboxDir: root,
  });
  const second = enqueueRunEvent({
    state, status: "done", summary: "complete", mailboxDir: root,
  });
  assert.equal(first.id, second.id);
  const calls = [];
  const result = deliverPendingEvents(root, {
    tmuxSend: (session, message) => calls.push([session, message]),
  });
  assert.equal(result.delivered, 1);
  assert.equal(calls.length, 1);
  assert.equal(deliverPendingEvents(root, {
    tmuxSend: () => calls.push("duplicate"),
  }).delivered, 0);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
node --test test/runs/notifications.test.mjs
```

Expected: missing module.

- [ ] **Step 3: Implement route validation and at-least-once outbox**

```js
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { atomicWriteJson } from "../json-store.mjs";

export function resolveNotificationRoute(parent, {
  required = false, hostCallbacks = {},
} = {}) {
  let route = parent?.notify ?? null;
  if (!route && parent?.attach === "tmux" && parent.tmux) {
    route = { kind: "tmux", session: parent.tmux };
  }
  if (route?.kind === "host_callback" && !hostCallbacks[route.id]) route = null;
  if (required && !route) {
    const error = new Error("PARENT_NOTIFICATION_UNAVAILABLE");
    error.code = "PARENT_NOTIFICATION_UNAVAILABLE";
    throw error;
  }
  return route;
}

export function enqueueRunEvent({
  state, status, summary, question = null, mailboxDir,
}) {
  const id = crypto.createHash("sha256").update([
    state.runId, status, String(state._stateRevision ?? 0),
  ].join(":")).digest("hex").slice(0, 24);
  const event = {
    schema: "team-up.run-event/v1", id, run_id: state.runId,
    status, summary, question, revision: state._stateRevision ?? 0,
    route: state.parent?.notify ?? (
      state.parent?.attach === "tmux" && state.parent.tmux
        ? { kind: "tmux", session: state.parent.tmux } : null
    ),
  };
  const outbox = path.join(mailboxDir, "notifications");
  fs.mkdirSync(outbox, { recursive: true });
  const pending = path.join(outbox, `${id}.json`);
  if (!fs.existsSync(pending) &&
      !fs.existsSync(path.join(outbox, `${id}.delivered.json`))) {
    atomicWriteJson(pending, event);
  }
  return event;
}

export function deliverPendingEvents(mailboxDir, {
  tmuxSend = (session, message) => {
    execFileSync("tmux", ["send-keys", "-t", session, "-l", message]);
    execFileSync("tmux", ["send-keys", "-t", session, "Enter"]);
  },
  runCommand = (argv, input) => spawnSync(argv[0], argv.slice(1), {
    input, encoding: "utf8", shell: false,
  }),
  hostCallbacks = {},
} = {}) {
  const outbox = path.join(mailboxDir, "notifications");
  if (!fs.existsSync(outbox)) return { delivered: 0, failed: [] };
  let delivered = 0;
  const failed = [];
  for (const name of fs.readdirSync(outbox).filter((n) =>
    n.endsWith(".json") && !n.endsWith(".delivered.json"))) {
    const pending = path.join(outbox, name);
    const event = JSON.parse(fs.readFileSync(pending, "utf8"));
    try {
      const message = `[team-up ${event.status}] ${event.run_id}: ${event.summary}`;
      if (event.route?.kind === "tmux") tmuxSend(event.route.session, message);
      else if (event.route?.kind === "command") {
        const result = runCommand(event.route.argv, JSON.stringify(event));
        if (result.status !== 0) throw new Error(`notifier exit ${result.status}`);
      } else if (event.route?.kind === "host_callback") {
        hostCallbacks[event.route.id](event);
      } else throw new Error("no notification route");
      fs.renameSync(pending,
        path.join(outbox, name.replace(/\.json$/, ".delivered.json")));
      delivered++;
    } catch (error) {
      failed.push({ id: event.id, error: String(error.message || error) });
    }
  }
  return { delivered, failed };
}
```

Add `notifyRunObservation(runId, classified, dependencies)` to `runs.mjs`. It
enqueues terminal/question events after durable reconciliation and attempts
delivery. Call it from `waitMailbox` both for immediate and post-wait results.

- [ ] **Step 4: Verify retry and command argv behavior**

```bash
node --test test/runs/notifications.test.mjs test/runs/runs.test.mjs
git add src/runs/notifications.mjs src/runs/runs.mjs \
  test/runs/notifications.test.mjs test/runs/runs.test.mjs
git commit -m "feat: deliver durable run notifications"
```

Expected: tests PASS; command route never uses a shell.

### Task 5: Roster Dispatch Startup Integration

**Files:**

- Modify: `src/roster/command.mjs`
- Create: `test/roster/startup.test.mjs`

- [ ] **Step 1: Write failing end-to-end spawn tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnPinnedInTmux } from "../../src/roster/command.mjs";

test("Cursor auth prompt becomes a durable human question", async () => {
  const events = [];
  const result = await spawnPinnedInTmux(fixture({
    runId: "run-auth",
    dependencies: {
      spawnTmux: () => events.push("spawn"),
      linkRun: () => events.push("link"),
      observeStartup: () => ({ status: "blocked", blocker: {
        kind: "auth", question: "open https://cursor/login",
        evidence: { url: "https://cursor/login" },
      } }),
      writeQuestion: () => events.push("question"),
      notify: () => events.push("notify"),
    },
  }));
  assert.equal(result.status, "waiting_human");
  assert.deepEqual(events, ["spawn", "link", "question", "notify"]);
});

test("healthy Cursor becomes watching only after ready", async () => {
  const events = [];
  await spawnPinnedInTmux(fixture({
    dependencies: {
      spawnTmux: () => events.push("spawn"),
      linkRun: () => events.push("link"),
      observeStartup: () => ({ status: "ready" }),
      markWatching: () => events.push("watching"),
    },
  }));
  assert.deepEqual(events, ["spawn", "link", "watching"]);
});

function fixture({ runId = "run-ready", dependencies = {} } = {}) {
  return {
    roster: {
      clis: { cursor: {
        cmd: ["cursor-agent", "--yolo", "--model", "{model}", "{prompt}"],
      } },
      models: { "grok-4.5-high": { cli: ["cursor"] } },
    },
    model: "grok-4.5-high",
    cli: "cursor",
    dir: "/tmp/project",
    prompt: "work",
    runId,
    sessionPrefix: "team-up-test",
    dependencies,
  };
}
```

- [ ] **Step 2: Run and verify RED**

```bash
node --test test/roster/startup.test.mjs
```

Expected: injected startup dependencies are not supported.

- [ ] **Step 3: Integrate observer before watching**

Refactor `spawnPinnedInTmux` to accept one `dependencies` object with defaults:

```js
const defaults = {
  spawnTmux: ({ session, dir, argv }) =>
    execFileSync("tmux", tmuxArgs({ session, dir, argv }), { stdio: "inherit" }),
  linkRun: linkDispatchToRun,
  observeStartup: observeHarnessStartup,
  getClassifier: getStartupClassifier,
  markWatching: markRunWatching,
  writeQuestion: writeRunQuestion,
  failStartup: failRunStartup,
  notify: notifyRunObservation,
};

deps.spawnTmux({ session, dir, argv });
if (!runId) {
  return { session, model, cli, effort, status: "fire_and_forget" };
}
deps.linkRun(runId, session);
const startup = deps.observeStartup({
  session,
  classifier: deps.getClassifier(cli),
});
if (startup.status === "blocked") {
  deps.writeQuestion(runId, startup.blocker);
  deps.notify(runId, {
    status: "question", question: startup.blocker.question,
  });
  return { session, model, cli, effort, status: "waiting_human" };
}
if (startup.status === "failed") {
  deps.failStartup(runId, startup.reason, startup.snapshot);
  deps.notify(runId, { status: "failed", summary: startup.reason });
  return { session, model, cli, effort, status: "failed" };
}
deps.markWatching(runId);
return { session, model, cli, effort, status: "watching" };
```

Do not print an attach success line before the startup result is known.

- [ ] **Step 4: Verify and commit**

```bash
node --test test/roster/startup.test.mjs test/roster/chain.test.mjs \
  test/runs/runs.test.mjs
git add src/roster/command.mjs test/roster/startup.test.mjs
git commit -m "fix: observe roster workers before watching"
```

Expected: focused tests PASS.

### Task 6: Specialist Startup Uses the Same Observer

**Files:**

- Modify: `src/supervisor/start.mjs`
- Modify: `test/integration/production-entrypoint.test.mjs`
- Modify: `test/supervisor/review3-remediation.test.mjs`

- [ ] **Step 1: Write failing specialist blocker regression**

```js
test("specialist auth blocker preserves tmux and asks human", async () => {
  await withTempEnv(async () => {
    const run = createRun({
      cwd: "/tmp", role: "specialist:r3",
      parent: { cli: "team-up", attach: "manual" },
      worker: { cli: "claude", model: "m1" }, prompt: "hi",
    });
    persistLaunchDescriptor(run.runId, makeDescriptor(run.runId));
    const attempt = createAttempt({
      runId: run.runId, runtime: { cli: "claude", model: "m1" },
    });
    acquireAttemptLease({
      runId: run.runId, attemptId: attempt.id, expectedPrevious: null,
    });
    const result = startFromLaunchDescriptor({
      runId: run.runId,
      attempt,
      startTmux: () => {},
      observeStartup: () => ({ status: "blocked", blocker: {
        kind: "auth", question: "open login URL",
        evidence: { url: "https://login.example/device" },
      } }),
      notify: () => ({ delivered: 1, failed: [] }),
    });
    const state = loadState(run.runId);
    assert.equal(state.status, "waiting_human");
    assert.match(fs.readFileSync(path.join(
      runDir(run.runId), "mailbox", "QUESTIONS.md"), "utf8"),
      /https:\/\/login\.example\/device/);
    assert.equal(result.status, "waiting_human");
  });
});
```

Add sibling tests for explicit ready and early exit. A blocker keeps the worker
TMUX and lease alive so the human can complete login; an early exit releases
the lease. Keep one `production-entrypoint.test.mjs` test with its fake TMUX
extended to support `capture-pane -J`, proving the production default reaches
the observer without injected callbacks.

- [ ] **Step 2: Run and verify RED**

```bash
node --test test/integration/production-entrypoint.test.mjs
```

Expected: specialist start marks `watching` immediately.

- [ ] **Step 3: Move watching certification after observation**

After lease owner transfer, call the same `observeHarnessStartup` contract.
Use `getStartupClassifier(prepared.cli)`. For blocked:

```js
writeRunQuestion(runId, startup.blocker);
notifyRunObservation(runId, {
  status: "question",
  question: startup.blocker.question,
});
return {
  runId, attempt: activeAttempt, session, argv: prepared.argv,
  sandbox: prepared.sandbox, enforced: prepared.enforced,
  status: "waiting_human",
};
```

Add these defaults to the `startFromLaunchDescriptor` parameter object:

```js
observeStartup = observeHarnessStartup,
getClassifier = getStartupClassifier,
writeQuestion = writeRunQuestion,
failStartup = failRunStartup,
notify = notifyRunObservation,
```

For failed startup, kill TMUX, release the attempt lease, call
`failRunStartup`, notify, and throw an error with code
`HARNESS_STARTUP_FAILED`. Only the ready branch persists `watching`.

- [ ] **Step 4: Verify and commit**

```bash
node --test test/integration/production-entrypoint.test.mjs \
  test/supervisor/production.test.mjs
git add src/supervisor/start.mjs \
  test/integration/production-entrypoint.test.mjs
git commit -m "fix: observe specialist startup before watching"
```

Expected: all focused tests PASS.

### Task 7: Require a Wake-Capable Parent and Retry Notifications

**Files:**

- Modify: `src/runs/runs.mjs`
- Modify: `src/roster/roster.mjs`
- Modify: `test/runs/runs.test.mjs`
- Modify: `test/runs/resume-reconcile.test.mjs`

- [ ] **Step 1: Write failing route validation tests**

```js
test("supervised create rejects manual parent without notifier", () => {
  assert.throws(() => createRun({
    cwd: "/tmp/project", role: "implementer",
    worker: { cli: "cursor", model: "grok-4.5-high" },
    prompt: "work",
    supervised: true,
    parent: { cli: "codex", attach: "manual" },
  }), /PARENT_NOTIFICATION_UNAVAILABLE/);
});

test("supervised create accepts explicit command notifier", () => {
  const state = createRun({
    cwd: "/tmp/project", role: "implementer",
    worker: { cli: "cursor", model: "grok-4.5-high" },
    prompt: "work",
    supervised: true,
    parent: {
      cli: "codex", attach: "manual",
      notify: { kind: "command", argv: ["/usr/bin/true"] },
    },
  });
  assert.equal(state.parent.notify.kind, "command");
});

test("resume retries pending notification outbox", () => {
  const delivered = [];
  resumeAll({
    deliverNotifications: (mailbox) => delivered.push(mailbox),
    execute: () => {},
  });
  assert.equal(delivered.length, 1);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
node --test test/runs/runs.test.mjs test/runs/resume-reconcile.test.mjs
```

Expected: `supervised` and notification retry are ignored.

- [ ] **Step 3: Persist and validate routes**

Add `supervised = false` to `createRun`. When true:

```js
const notify = resolveNotificationRoute(parent, {
  required: true,
  hostCallbacks,
});
```

Persist only serializable route data. Validate:

```js
if (notify.kind === "command" &&
    (!Array.isArray(notify.argv) || notify.argv.length === 0 ||
     notify.argv.some((part) => typeof part !== "string"))) {
  throw new Error("PARENT_NOTIFICATION_INVALID: command argv required");
}
```

CLI `runs create` adds:

```text
--parent-notify-command-json '["/absolute/notifier","--flag"]'
--fire-and-forget
```

Without `--fire-and-forget`, creation is supervised. `parent-attach tmux`
requires `--parent-tmux`. The roster `dispatch --run-id` revalidates the
stored route before spawning, closing the create/dispatch gap.

At the beginning and end of each `resumeAll` run, invoke
`deliverPendingEvents(mailboxDir(runId))` for every active or terminal run.

- [ ] **Step 4: Update existing test fixtures explicitly**

Existing low-level mailbox tests that intentionally do not supervise add
`supervised: false`. Production Path-B tests use fake command or TMUX routes.
Never weaken the new production assertion merely to retain old fixtures.

- [ ] **Step 5: Verify and commit**

```bash
node --test test/runs/runs.test.mjs test/runs/resume-reconcile.test.mjs \
  test/roster/startup.test.mjs
npm test
git add src/runs/runs.mjs src/roster/roster.mjs test/runs/runs.test.mjs \
  test/runs/resume-reconcile.test.mjs test/roster/startup.test.mjs
git commit -m "feat: require supervisor notification routes"
```

Expected: full suite PASS.

### Task 8: End-to-End Supervisor Wake and Documentation

**Files:**

- Create: `test/integration/supervisor-notification.test.mjs`
- Modify: `test/runs/wait-mailbox.test.sh`
- Modify: `docs/MULTI-AGENT.md`

- [ ] **Step 1: Write failing fake-TMUX integration**

```js
test("Cursor login and completion wake the parent exactly once", async () => {
  const parentMessages = [];
  let pane = "";
  const fixture = {
    setPane: (_session, text) => { pane = text; },
    parentMessages,
    dependencies: {
      spawnTmux: () => {},
      linkRun: linkDispatchToRun,
      getClassifier: () => classifyCursorStartup,
      observeStartup: ({ classifier }) => {
        const classified = classifier(pane);
        return classified?.kind
          ? { status: "blocked", blocker: classified }
          : { status: "ready" };
      },
      writeQuestion: writeRunQuestion,
      notify: notifyRunObservation,
    },
    notificationDependencies: {
      tmuxSend: (_session, message) => parentMessages.push(message),
    },
  };
  const run = createRun({
    cwd: "/tmp/project", role: "implementer", prompt: "work",
    supervised: true,
    parent: { cli: "codex", attach: "tmux", tmux: "parent-session" },
    worker: { cli: "cursor", model: "grok-4.5-high" },
  });
  fixture.setPane("worker-session", [
    "Signing in",
    "https://cursor.com/loginDeepControl?challenge=x&uuid=y",
  ].join("\n"));
  await spawnPinnedInTmux({
    roster: {
      clis: { cursor: {
        cmd: ["cursor-agent", "--yolo", "--model", "{model}", "{prompt}"],
      } },
      models: { "grok-4.5-high": { cli: ["cursor"] } },
    },
    model: "grok-4.5-high", cli: "cursor", dir: "/tmp/project",
    prompt: "work", runId: run.runId, sessionPrefix: "worker",
    dependencies: fixture.dependencies,
  });
  assert.equal(loadState(run.runId).status, "waiting_human");
  assert.match(fixture.parentMessages[0], /team-up question/);
  assert.match(fs.readFileSync(path.join(
    runDir(run.runId), "mailbox", "QUESTIONS.md"), "utf8"), /challenge=x/);

  atomicWriteText(path.join(runDir(run.runId), "mailbox", "RESULT.md"),
    "finished");
  atomicWriteText(path.join(runDir(run.runId), "mailbox", "STATUS"), "done");
  waitMailbox(run.runId, { ceilingSec: 1,
    notificationDependencies: fixture.notificationDependencies });
  assert.equal(fixture.parentMessages.filter((x) =>
    x.includes("team-up done")).length, 1);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
node --test test/integration/supervisor-notification.test.mjs
```

Expected: integration helpers or notification flow are missing.

- [ ] **Step 3: Add shell wake ordering regression**

Extend `test/runs/wait-mailbox.test.sh` to start `runs wait`, atomically write
`QUESTIONS.md` then `STATUS=waiting_human`, and assert the waiter prints:

```text
status: question
question: Open the login URL
```

Repeat with `RESULT.md` plus `STATUS=done` and assert one delivered outbox
event.

- [ ] **Step 4: Document the new Path-B requirement**

Use `md-provenance` before editing `docs/MULTI-AGENT.md`. Document:

```bash
team-up runs create \
  --cwd "$TASK_DIR" --role implementer \
  --parent-cli codex --parent-attach tmux \
  --parent-tmux "$PARENT_TMUX" \
  --worker-cli cursor --prompt-file "$PROMPT"
```

State explicitly:

- TMUX existence is not startup readiness.
- `manual` needs an explicit notifier or `--fire-and-forget`.
- fire-and-forget has no supervisor completion guarantee.
- questions and results are durable even if notification delivery retries.

- [ ] **Step 5: Run complete verification**

```bash
node --test test/integration/supervisor-notification.test.mjs
bash test/runs/wait-mailbox.test.sh
npm test
git diff --check
```

Expected: all tests PASS, including login URL preservation, early-exit
failure, question wake, terminal wake, retry, and deduplication.

- [ ] **Step 6: Commit and review**

```bash
git add test/integration/supervisor-notification.test.mjs \
  test/runs/wait-mailbox.test.sh docs/MULTI-AGENT.md
git commit -m "test: verify supervisor startup notifications"
```

Use `superpowers:requesting-code-review` for both spec compliance and code
quality. Address findings test-first. Then run
`superpowers:verification-before-completion` and
`superpowers:finishing-a-development-branch`. Do not merge, push the feature
branch, or delete the worktree without human choice.
