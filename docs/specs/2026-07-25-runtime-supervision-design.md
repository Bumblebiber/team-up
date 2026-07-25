<!-- o9k-provenance
who: codex:gpt-5
when: 2026-07-25T15:00:35Z
why: Document the user-approved team-up command-broker, trust model, quota handoff, reset scheduling, and parent/controller architecture.
trigger: User approved the consolidated runtime supervision design.
host: codex
-->
# Team-up Runtime Supervision Design

**Status:** Approved in conversation on 2026-07-25
**Repository:** `team-up`
**Scope:** Specialist execution, command mediation, subscription-limit handoff,
and durable waiting/resumption

## Context

The first `team-up` MVP extracted roster selection, usage collection, mailbox
runs, specialist packaging, and an o9k compatibility adapter. Its security
review correctly rejected execution when the host could not prove operating
system sandboxing, when a specialist declared a command allowlist without a
command broker, or when a hard token budget lacked a concrete adapter.

That behavior was safe but made the two starter specialists impossible to run.
The revised design uses an explicit trust model:

- specialists are intentionally installed and approved collaborators;
- operating-system sandboxing is best effort, not a hard security boundary;
- declared filesystem and network permissions remain instructions and audit
  metadata;
- command allowlists remain technically enforced at the harness tool boundary;
- token counts are advisory; subscription/provider capacity drives handoff.

Model selection remains strict. A specialist requests an abstract tier and
reasoning level. No stronger or weaker tier may be selected automatically.

## Goals

1. Make approved specialists operational on the current headless host.
2. Define command policy once in `team-up`, independent of any harness syntax.
3. Prevent a specialist from using a harness's unrestricted shell when it
   declares a command allowlist.
4. Keep harness-specific policy translation small and testable.
5. Continue a specialist run across subscription limits while preserving its
   identity, durable state, and exact model requirements.
6. Report provider reset times and support cancellable automatic waiting.
7. Preserve recovery after parent-session, watcher, worker, or host restart.

## Non-goals

- defending against a deliberately malicious installed specialist;
- treating best-effort filesystem or network isolation as a security boundary;
- inspecting every subprocess started inside an approved project command;
- transferring hidden model state or private reasoning between harnesses;
- automatically changing a specialist's tier or reasoning requirement;
- allowing one specialist to recursively select another specialist;
- publishing or merging repositories as part of this design document.

## Trust and Enforcement Model

There are three distinct policy classes:

| Policy | Enforcement |
|---|---|
| Model tier and reasoning | Hard, deterministic resolver rule |
| Command allowlist | Hard at the harness tool/broker boundary |
| Filesystem, network, and token target | Best effort plus audit |

The command boundary protects against accidental or unapproved use of a
harness's normal shell tool. It does not claim protection against a malicious
worker exploiting its runtime or against arbitrary behavior inside an approved
test script. Project owners remain responsible for the commands they map.

## Architecture

### Parent Agent

The original agent that communicates with the human remains the fachlicher
Supervisor. It:

- explicitly chooses the specialist;
- supplies the objective and approved inputs;
- receives questions, results, capacity reports, and handoff notifications;
- integrates the specialist's result;
- applies human decisions such as changing the roster or cancelling a run.

The parent does not need to remain alive while the specialist works.

### Team-up Run Controller

Deterministic `team-up` code owns technical supervision:

- run and attempt state;
- model/CLI resolution;
- TMUX worker lifecycle;
- mailbox protocol;
- command-broker configuration;
- usage and heartbeat monitoring;
- quota handoff;
- capacity waiting and resumption;
- crash recovery and single-worker leasing.

This logic must not depend on an LLM remembering to perform orchestration.

### Mailbox Watcher

A cheap internal subagent may run `team-up runs wait <run-id>` and report
terminal states or questions to the parent. It is only a notification bridge.
It does not own durable state, model selection, TMUX lifecycle, or handoff
decisions.

### Specialist Worker

The external TMUX worker receives only:

- the selected specialist package and instructions;
- the normalized request;
- the project context allowed by the call;
- the mailbox protocol;
- the command-broker tool;
- the current attempt and any predecessor checkpoint.

Every successor receives the same specialist ID, package version, persona,
remit, anti-remit, objective, and output contract.

## Canonical Command Policy

Specialist manifests name abstract actions:

```json
{
  "capabilities": {
    "tools": ["filesystem.read", "command.test"]
  },
  "permissions": {
    "commands": ["project-test"]
  }
}
```

Projects map those actions to fixed argument arrays:

```json
{
  "schema_version": 1,
  "commands": {
    "project-test": {
      "argv": ["npm", "test"],
      "cwd": ".",
      "timeout_seconds": 1800,
      "environment": {}
    }
  }
}
```

The project policy lives at `.team-up/commands.json` and is approved with the
specialist for that project. A policy change invalidates the approval binding.
At launch, the controller verifies its checksum and copies an immutable policy
snapshot into the run directory outside the worker's writable workspace. The
broker uses only that snapshot for the lifetime of the attempt; it never
re-reads a worker-modifiable project file.

The broker:

- accepts an action ID, not an arbitrary command string;
- resolves only an action declared by both manifest and project policy;
- uses direct process execution without shell interpolation;
- rejects caller-supplied executable names, shell fragments, redirections,
  substitutions, environment overrides, and working-directory escapes;
- applies the configured timeout and a sanitized environment;
- records argv, cwd, timestamps, exit status, and bounded output in the run
  audit log.

For MVP, `project-test` accepts no free-form arguments. Future typed arguments
require a versioned schema and explicit validation.

## Harness Adapters

Harnesses expose different permission formats. `team-up` therefore owns a
small adapter per supported harness. An adapter must:

1. disable or deny the harness's unrestricted native shell tool;
2. expose the shared `team-up-command-broker` MCP tool;
3. provide any temporary harness configuration without mutating the user's
   persistent global configuration or placing policy files in the worker's
   writable workspace;
4. report its version and supported enforcement capabilities;
5. pass a conformance test proving that the broker works and raw shell use is
   denied.

The actual command policy is not reimplemented in adapters.

An adapter capability record resembles:

```json
{
  "id": "cursor-cli",
  "capabilities": {
    "command_broker": "team-up.command-broker/v1",
    "native_shell": "denied",
    "mcp": true
  }
}
```

If a harness cannot prove these properties, it is incompatible with a
specialist that declares command actions.

## Chain Generation

The global roster may contain CLIs that are valid for ordinary agents or other
specialists. A specialist chain contains only candidates satisfying all of:

- exact normalized tier;
- requested reasoning mapping;
- enabled account or available credit;
- provider/CLI usage below blocking thresholds;
- required harness capabilities;
- valid command-broker adapter when commands are declared;
- available runtime files.

Filtering happens while the chain is generated. Incompatible entries never
appear in the resulting specialist chain.

If no candidate remains, resolution returns `PROFILE_UNAVAILABLE` with
structured skip reasons. It never substitutes another tier.

## Token and Subscription Budgets

Hard `budget.max_tokens` enforcement is removed from the launch gate.

Schema v2 represents token guidance explicitly:

```json
{
  "budget": {
    "timeout_seconds": 1800,
    "tokens": {
      "target": 80000,
      "enforcement": "advisory"
    }
  }
}
```

Schema-v1 `max_tokens` is migrated to the advisory target with a warning. It
does not prevent launch. A future hard token adapter may introduce
`enforcement: "hard"`, but no hard behavior is implied until such an adapter
exists.

Subscription/provider usage windows remain hard inputs to roster eligibility
and handoff.

## Normalized Usage and Reset Contract

Every collector emits a common record:

```json
{
  "window": "claude:5h",
  "used": 0.96,
  "resets_at": "2026-07-25T18:10:00Z",
  "resets_at_raw": "Jul 25, 8:10pm (Europe/Berlin)",
  "reset_confidence": "provider",
  "updated_at": "2026-07-25T16:42:00Z",
  "source": "claude:/usage"
}
```

Rules:

- `resets_at` is an ISO-8601 instant or `null`;
- `resets_at_raw` preserves the original provider text;
- `reset_confidence` is `provider`, `parsed`, `estimated`, or `unknown`;
- `updated_at` is mandatory;
- stale or unparseable values are reported as unknown, never guessed;
- collectors preserve independent session, burst, weekly, model-specific, and
  CLI-specific windows.

For one candidate, availability begins after the latest reset among its
currently blocking windows. For a whole exact-profile chain,
`next_reset_at` is the earliest candidate-availability time.

## Automatic Quota Handoff

Default specialist thresholds are configurable in the roster:

```json
{
  "specialist_handoff": {
    "prepare_at": 0.90,
    "force_at": 0.95,
    "heartbeat_stale_seconds": 120
  }
}
```

Provider/window-specific thresholds may override these defaults. The usage
watcher collects more frequently while a specialist attempt is active.

At `prepare_at`:

1. the controller marks the attempt `handoff_requested`;
2. the worker stops beginning new work;
3. the worker writes `handoff_preparing` and refreshes its heartbeat;
4. it records completed work, open work, repository state, relevant diffs,
   artifacts, verification commands, risks, and questions;
5. it writes a typed checkpoint and marks `handoff_ready`.

The controller waits while the worker process exists, the heartbeat is fresh,
and the hard threshold has not been reached. It does not use a fixed
60-second kill timer.

At `handoff_ready`:

1. validate and persist the checkpoint;
2. revoke the old attempt's active lease;
3. stop the old worker;
4. refresh usage;
5. regenerate the exact-profile, capability-compatible chain;
6. select the next available entry, excluding the exhausted attempt;
7. start a successor with the same run and specialist identity;
8. notify the parent of the transition.

At `force_at`, on stale heartbeat, process exit, or provider rate-limit error,
the controller uses the last durable checkpoint and proceeds. The result marks
the checkpoint partial when graceful completion was not confirmed.

## Run and Attempt State

A specialist task owns one stable `run_id`. Each worker is an immutable
attempt:

```text
run specialist-123
  attempt 1 cursor:model-a  handoff
  attempt 2 codex:model-b   running
  attempt 3 claude:model-c  pending
```

Only one attempt may hold the active lease. Lease acquisition and transition
use atomic state writes and compare the expected previous attempt ID.

Relevant run states:

```text
starting
running
handoff_requested
handoff_preparing
handoff_ready
launching_successor
waiting_capacity
waiting_decision
done
partial
failed
cancelled
```

Attempts record concrete CLI/model/effort for audit. The specialist package
still contains no concrete model or provider.

## Capacity Waiting

When no compatible exact-tier successor is available, the run enters
`waiting_capacity` and writes:

```json
{
  "status": "waiting_capacity",
  "blocked_candidates": [],
  "next_reset_at": "2026-07-25T18:30:00Z",
  "reset_confidence": "provider",
  "auto_resume": false,
  "wait_cancelled": false,
  "available_actions": ["wait", "change_roster", "cancel_run"]
}
```

The watcher reports the blocking windows, utilization, reset data, affected
candidates, and available actions to the parent and human.

No waiting begins automatically. After the human or parent chooses `wait`:

- `auto_resume` becomes true;
- a durable `resume_not_before` value is stored;
- restart recovery restores the scheduled check;
- the controller refreshes usage at that time rather than trusting the old
  prediction;
- if capacity is available, it resumes and notifies the parent;
- if the reset moved or capacity remains blocked, it updates the report and
  continues waiting.

The human may cancel waiting at any time. This disables automatic resumption
and moves the preserved run to `waiting_decision`. It does not delete the
workspace, mailbox, checkpoint, or attempts.

Available decisions from `waiting_decision` are:

- wait again;
- change the roster and re-resolve;
- attempt an explicitly requested immediate recheck;
- cancel the run.

## Recovery and Failure Handling

- Parent loss: the worker and controller continue; a later parent reattaches.
- Watcher loss: durable state continues; a replacement watcher attaches.
- Controller/host restart: active runs and waits are reconstructed from disk.
- Worker crash: use the last durable checkpoint and repository state.
- Successor launch failure: remain without an active lease, refresh the chain,
  and either retry another compatible candidate or enter `waiting_capacity`.
- Invalid checkpoint: mark it partial and preserve raw artifacts for review.
- Unknown reset time: report it as unknown and require an explicit decision.
- Exhausted exact-tier chain: never upgrade or downgrade automatically.
- Concurrent transition: only the atomic lease winner may launch a successor.

## Required Tests

### Command Broker

- declared action succeeds through the MCP broker;
- undeclared action fails;
- arbitrary executable, arguments, shell syntax, cwd escape, and environment
  injection fail;
- policy changes invalidate project approval;
- audit records are complete and bounded.

### Harness Conformance

For every supported harness:

- native shell request is denied;
- broker MCP tool is available;
- `project-test` reaches the broker;
- temporary configuration does not mutate global user settings;
- an unsupported harness is excluded before chain creation.

### Resolver

- exact tier and reasoning only;
- compatible adapter filtering;
- no stronger or weaker fallback;
- structured reasons for every skipped candidate;
- `PROFILE_UNAVAILABLE` when no exact compatible candidate exists.

### Usage and Reset

- Claude, Codex, Cursor, and future collector fixtures;
- timezone and year-boundary normalization;
- raw reset preservation;
- unknown and stale reset handling;
- candidate and chain availability calculations.

### Handoff State Machine

- prepare threshold;
- fresh-heartbeat lease extension;
- graceful checkpoint;
- forced partial checkpoint;
- single-active-worker invariant;
- successor selection with exhausted candidate excluded;
- rate-limit and process-crash transitions;
- no exact-tier successor.

### Waiting and Recovery

- durable wait across restart;
- automatic recheck at reset;
- moved reset time;
- cancel wait without deleting state;
- roster change followed by re-resolution;
- watcher and parent reattachment;
- concurrent controller recovery.

## Acceptance Criteria

The design is complete when:

1. Hannes can run `project-test` through the shared broker.
2. Hannes cannot invoke an unrestricted harness shell through normal tools.
3. Hugo and Hannes launch without a hard token-adapter requirement.
4. Filesystem and network policy are clearly labelled best effort.
5. Specialist chains contain only compatible harnesses at the exact tier.
6. At 90% usage, a running specialist prepares a durable checkpoint.
7. A healthy checkpointing worker is observed rather than immediately killed.
8. At 95%, stale heartbeat, exit, or rate limit, the controller progresses
   using the latest durable state.
9. Successors preserve run and specialist identity while recording a new
   concrete attempt.
10. Exhausted chains report normalized reset information.
11. Approved waits survive restart, automatically recheck, and can be
    cancelled without data loss.
12. Parent, watcher, controller, and worker responsibilities remain separate.
13. All transitions are covered by deterministic tests.

## Repository Boundaries

- `team-up` owns policy, broker, adapters, roster, usage, controller, mailbox,
  and run state.
- Each `team-up-with-*` repository owns only one specialist package, its
  instructions, and evals.
- o9k owns only a thin compatibility adapter and user-facing integration.
- Specialist repositories contain abstract model profiles and no fixed model
  identifiers.
