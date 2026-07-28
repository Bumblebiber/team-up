# Terminal Worker TMUX Cleanup

## Problem

Path-B workers report completion through the run mailbox, but the watcher only
returns the terminal status. Interactive worker CLIs can therefore remain alive
inside detached TMUX sessions after their run is `done`, `failed`, or
`cancelled`.

## Decision

Terminal worker cleanup has two owners with distinct roles:

1. The watcher-side `runs wait` flow performs immediate cleanup after mailbox
   reconciliation confirms `done`, `failed`, or `cancelled`.
2. A periodic `team-up runs gc` safety sweep catches terminal sessions missed
   by the watcher and applies the stale-worker policy below.

Both paths best-effort kill only the TMUX session recorded in `STATE.json` at
`worker.tmux`. Cleanup never targets the parent session. Missing or
already-ended sessions are treated as success.

Nonterminal states remain untouched:

- `question` / `waiting_human`: worker stays available for an answer.
- `watching`, `starting`, capacity waits, and decision waits: no cleanup.

The worker-side `runs set-status` command does not perform cleanup. A worker may
invoke that command from inside its own TMUX pane; killing the pane there would
race the mailbox closeout command itself. The independent watcher observes the
durable terminal state and performs cleanup safely.

## Periodic Safety Sweep

`team-up runs gc` runs every five minutes through a user-level timer.
`team-up runs gc-install` creates and enables that timer. Installation resolves
and persists the actual Node and `team-up` executable paths rather than relying
on an interactive-shell `PATH`. On hosts without user systemd, `gc-install`
fails explicitly while manual `team-up runs gc` remains available.

Each sweep handles runs as follows:

1. Terminal `done`, `failed`, or `cancelled` run with a live worker TMUX session:
   kill the session immediately.
2. `question`, `waiting_human`, `waiting_capacity`, `waiting_decision`,
   `handoff_preparing`, and `handing_off`: never stale-kill.
3. Active `starting` or `watching`: compare both mailbox `HEARTBEAT` and TMUX
   `window_activity` against the current time.
4. If either signal is newer than 30 minutes, clear any prior stale candidate.
5. If both signals are older than 30 minutes, persist
   `cleanup.stale_detected_at`. Do not kill on that sweep.
6. If both signals remain stale for another 10 minutes, create a synthetic
   failed result with reason `worker_stale_timeout`, persist terminal failure,
   release any active attempt lease, then kill the worker TMUX session.

Synthetic failure writes `RESULT.json` with schema `team-up.result/v1` for typed
runs and `RESULT.md` for legacy runs, then writes mailbox `STATUS=failed` and
durable `STATE.status=failed` before releasing or killing anything.

Missing or malformed activity timestamps count as stale, but the 10-minute
grace period still applies. A missing TMUX session is handled by existing crash
recovery rather than stale cleanup.

The sweep is idempotent. Repeated execution does not duplicate result artifacts
or alter already-terminal outcomes. A dry-run mode reports decisions without
writing state or killing sessions.

## Activity Semantics

Mailbox `HEARTBEAT` represents protocol-level progress. TMUX
`#{window_activity}` represents recent pane output. Neither signal alone proves
useful work, so stale termination requires both to exceed the 30-minute
threshold.

The persisted stale-candidate timestamp provides the 10-minute grace window.
Any fresh signal clears it, allowing a quiet worker that resumes activity to
continue normally.

## Alternatives Considered

1. **Watcher-owned cleanup (selected).** Matches the existing callback owner,
   avoids self-termination races, and gives terminal handling one predictable
   location.
2. **Worker-owned cleanup.** The worker exits or kills its own TMUX session
   after writing `STATUS`. This depends on every CLI exiting correctly and can
   interrupt its own closeout command.
3. **Parent-protocol-only cleanup.** Add a documented manual `tmux
   kill-session` step after result ingestion. This remains easy to skip and
   preserves the current leak failure mode.
4. **Single-signal idle timeout.** Kill based only on heartbeat or TMUX output.
   Rejected because workers can forget heartbeats and interactive CLIs can emit
   cosmetic output while idle.

## Error Handling

TMUX cleanup is best-effort. `tmux kill-session` errors are ignored because the
session may have exited naturally between mailbox classification and cleanup.
Mailbox status and result delivery remain authoritative and must not be changed
to failure by cleanup.

## Tests

Regression tests exercise `waitMailbox` with an injected TMUX stopper:

- `done`, `failed`, and `cancelled` stop the recorded worker session.
- `question` leaves the worker session alive.
- Terminal runs without a recorded worker session remain successful.

Deterministic GC tests use injected clock, activity lookup, TMUX liveness,
stopper, and lease releaser:

- Either fresh signal clears stale candidacy.
- Dual 30-minute staleness records candidacy without killing.
- Continued staleness through the 10-minute grace creates
  `worker_stale_timeout`, releases the lease, and kills worker TMUX.
- Protected states never stale-kill.
- Terminal orphan cleanup and repeated sweeps are idempotent.
- Dry-run never mutates state or TMUX.
- Timer installation uses absolute executable paths.

Focused run-state tests execute first, followed by the complete test suite.
