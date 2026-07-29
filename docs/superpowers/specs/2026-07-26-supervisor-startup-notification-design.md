<!-- o9k-provenance
who: codex:gpt-5
when: 2026-07-26T12:42:08Z
why: Specify fail-closed startup blocker detection and guaranteed supervisor notification
trigger: User approved adapter-owned startup observation and immediate supervisor notification
host: codex
-->
# Supervisor Startup and Notification Design

## Status

Approved design, pending implementation planning.

## Problem

`team-up dispatch` currently treats successful `tmux new-session` as a
successfully started worker. It immediately marks the mailbox `watching`.

That is false when the harness is still showing a login, workspace-trust,
device-code, permission, or other pre-model interaction. The worker has not
received the mailbox prompt and therefore cannot report the blocker itself.
The existing watcher then waits forever for a mailbox transition.

A second failure occurs after a real terminal mailbox transition: `runs wait`
returns correctly, but a supervisor without a wake-capable callback may remain
inactive until the human sends another message. Durable state alone is not an
immediate notification.

## Goals

- Never mark an external worker `watching` merely because TMUX exists.
- Detect known pre-model blockers through harness-owned exact classifiers.
- Preserve actionable URLs, device codes, and prompt text without line wraps.
- Write the question durably before waking the supervisor.
- Deliver every `question`, `done`, `failed`, and `cancelled` event through a
  wake-capable parent channel.
- Refuse asynchronous dispatch when no wake-capable channel exists.
- Use the same startup observer for roster workers and specialist workers.

## Non-Goals

- Parsing arbitrary terminal output throughout the full worker lifetime.
- Treating substring matches such as `login` or `authentication` as blockers.
- Automating credentials, browser login, workspace trust, or human approval.
- Replacing the mailbox as the durable source of truth.
- Providing an OS-security boundary.

## Architecture

### Harness startup classifier

Each supported harness adapter may expose:

```js
classifyStartup(snapshot) =>
  null |
  {
    kind: "auth" | "trust" | "permission" | "interactive",
    question: string,
    evidence: {
      url?: string,
      device_code?: string,
      prompt: string
    }
  }
```

The adapter owns all harness-specific wording. The generic supervisor never
searches for broad words.

Cursor initially recognizes exact structural evidence:

- `Signing in` together with a `cursor.com/loginDeepControl` URL;
- `Press any key to log in`;
- QR/device-code login instructions;
- known workspace-trust prompts.

Claude, Codex, Hermes, and OpenCode add their own classifiers only when backed
by captured fixtures and tests. An absent classifier does not imply readiness.

### Bounded startup observer

After `tmux new-session`, the generic observer:

1. captures the joined pane with `tmux capture-pane -p -J`;
2. checks whether the pane/process still exists;
3. passes the snapshot only to the selected harness classifier;
4. repeats with condition-based waiting until one terminal startup outcome;
5. never performs unbounded lifetime terminal scraping.

Outcomes:

- recognized blocker: `waiting_human`;
- worker exits before readiness: `failed`;
- explicit readiness evidence: `watching`;
- startup deadline without readiness evidence: `failed`, not `watching`.

Readiness is harness-specific. A non-empty pane is not readiness. For
interactive harnesses, consuming the mailbox prompt or producing the normal
agent-ready marker is acceptable evidence.

### Atomic question transition

For a blocker, writes occur in this order:

1. `mailbox/QUESTIONS.md`;
2. structured event in `mailbox/EVENTS.jsonl`;
3. `STATE.json.status = "waiting_human"`;
4. `mailbox/STATUS = "waiting_human"`;
5. parent notification.

`STATUS` is written last so a watcher cannot wake before the question and its
evidence are durable.

The question includes the exact unwrapped URL or device code. Secrets other
than the user-facing one-time login artifact are redacted.

### Parent notification contract

Every run records a notification route:

```json
{
  "parent": {
    "cli": "codex",
    "attach": "tmux",
    "tmux": "codex-team-up-019f9936",
    "notify": {
      "kind": "tmux"
    }
  }
}
```

Supported routes:

- `tmux`: inject a short event into the known parent TMUX session;
- `command`: execute a configured argv-only notifier with event JSON on stdin;
- `host_callback`: use a host-provided callback that is verified during run
  creation.

There is no implicit shell command. Notifier argv comes from trusted user
configuration, and event fields are passed as data.

`manual` without a verified notifier is not wake-capable. Path-B dispatch with
such a parent fails before worker creation with
`PARENT_NOTIFICATION_UNAVAILABLE`. A foreground human-debug session may opt
into fire-and-forget explicitly, but it is not a supervised async run and
cannot claim that the supervisor will be notified.

### Terminal event delivery

The same notifier handles:

- `waiting_human`;
- `done`;
- `failed`;
- `cancelled`.

Delivery is at-least-once. Each event has a stable ID derived from run ID,
status, and state revision. Notification sinks must deduplicate by event ID.
Failures remain in a durable outbox and are retried by `runs resume` or the
usage watcher. A terminal mailbox state is never rolled back because
notification delivery failed.

The human-facing supervisor receives only a short summary and then reads the
durable mailbox artifact. Large results are not injected into the parent
prompt.

## State Machine

```text
created
  -> starting
      -> waiting_human  recognized startup blocker
      -> watching       explicit harness readiness
      -> failed         early exit or startup deadline

watching
  -> waiting_human
  -> done
  -> failed
  -> cancelled
```

`linkDispatchToRun` links the TMUX identity but no longer changes `starting`
to `watching`. Only the startup observer may certify that transition.

## Integration Points

- `src/harness/cursor.mjs`: exact Cursor startup classifier.
- `src/harness/startup.mjs`: generic bounded observer.
- `src/harness/registry.mjs`: exposes startup classifiers separately from
  command-broker/context-isolation capabilities.
- `src/roster/command.mjs`: observes roster dispatch startup.
- `src/supervisor/start.mjs`: observes specialist startup.
- `src/runs/runs.mjs`: atomic question transition, event outbox, notifier
  contract, and removal of unconditional `watching`.
- `scripts/wait-mailbox.sh`: remains the durable terminal-state wait primitive.

## Failure Handling

- TMUX creation failure: run becomes `failed`.
- Recognized blocker: worker remains alive and run becomes `waiting_human`.
- Parent notifier failure: event stays pending in the outbox; run state remains
  truthful.
- Parent TMUX missing: notifier fails and retries; it never silently reports
  delivery.
- Unknown startup output: startup deadline fails closed with captured bounded
  diagnostic evidence.
- Duplicate notifier execution: stable event ID prevents duplicate human
  messages where the sink supports deduplication.

## Tests

### Classifier

- Exact wrapped Cursor login transcript produces one unwrapped URL.
- QR/device-code prompt preserves its actionable code.
- Normal Cursor startup returns no blocker.
- Unrelated prose containing `login` or `authentication` does not trigger.

### Observer

- Empty pane followed by login becomes `waiting_human`.
- Explicit ready marker becomes `watching`.
- Early pane death becomes `failed`.
- Startup deadline becomes `failed`.
- Observer stops after readiness and does not scrape lifetime output.

### Mailbox and notification

- `QUESTIONS.md` exists before `STATUS=waiting_human`.
- `runs wait` returns immediately with the exact question.
- `done` creates a terminal event and invokes the parent notifier.
- Failed delivery remains in the outbox and succeeds after `runs resume`.
- Stable event IDs deduplicate retries.
- Async dispatch refuses `manual` without a notifier.

### Integration

- Roster Cursor login prompt wakes a fake parent TMUX with the exact URL.
- Specialist launch uses the same observer.
- Healthy startup reaches `watching` only after readiness.
- Completion wakes the parent without a new human chat message.

## Rollout

1. Cursor classifier, observer, truthful state transition, and tests.
2. Parent TMUX notifier, durable outbox, and terminal-event delivery.
3. Fail-closed notification-route validation for async dispatch.
4. Additional harness classifiers from captured fixtures.

No rollout phase may restore non-empty-pane readiness or silent `manual`
supervision.
