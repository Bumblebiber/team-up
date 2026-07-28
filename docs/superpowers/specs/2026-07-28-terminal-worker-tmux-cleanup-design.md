# Terminal Worker TMUX Cleanup

## Problem

Path-B workers report completion through the run mailbox, but the watcher only
returns the terminal status. Interactive worker CLIs can therefore remain alive
inside detached TMUX sessions after their run is `done`, `failed`, or
`cancelled`.

## Decision

The watcher-side `runs wait` flow owns terminal worker cleanup.

After mailbox reconciliation confirms `done`, `failed`, or `cancelled`, it
best-effort kills the TMUX session recorded in `STATE.json` at `worker.tmux`.
Cleanup never targets the parent session. Missing or already-ended sessions are
treated as success.

Nonterminal states remain untouched:

- `question` / `waiting_human`: worker stays available for an answer.
- `watching`, `starting`, capacity waits, and decision waits: no cleanup.

The worker-side `runs set-status` command does not perform cleanup. A worker may
invoke that command from inside its own TMUX pane; killing the pane there would
race the mailbox closeout command itself. The independent watcher observes the
durable terminal state and performs cleanup safely.

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

Focused run-state tests execute first, followed by the complete test suite.
