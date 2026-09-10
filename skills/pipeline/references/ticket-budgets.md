# Ticket budgets and worker capacity

Read this policy before dispatching a specialist, charging a review, or reporting a budget stop. It governs coordinator accounting; it is not a runtime concurrency limit. Numeric budgets come from the applicable project/workflow instructions or an explicit user budget.

## Scope and ledger

Assign each substantive run to one stable ticket ID before dispatch. A multi-ticket request has separate ticket budgets, not one cumulative program budget. A shared integration review has its own declared integration-ticket scope and is charged once there, not retroactively against every reviewed ticket. Link findings back to the affected tickets.

Record ticket ID, run ID, role, whether the run counts and why, completed review rounds, and execution intervals. Reconstruct missing accounting from run artifacts before claiming a cap. A repository-wide run count or number of tmux sessions is not a ticket ledger. Continuing a chat, restarting a watcher, renaming a ticket, or creating a new clone does not reset its budget; a budget extension requires user direction.

## What counts

- Count a specialist invocation once substantive implementation, research, planning, or review actually begins. Completion or failure afterwards does not erase that work.
- Exclude transport-only watchers, mailbox waits, cleanup, status collection, and launch failures before substantive work starts.
- A failed run with code, analysis or review artifacts still counts. Recover those artifacts before retrying; a missing completion message does not prove the worker did nothing.
- Count a review round when an independent review of the ticket or declared integration scope completes. A watcher notification is not another round.
- Time caps measure elapsed execution while substantive work runs for that scope. Count overlapping intervals once; exclude user pauses, provider/capacity waits and idle time after completion. Report unknown timing as unknown, not as elapsed calendar time since the ticket was created.

## At a cap

A cap prevents starting more substantive work on that unfinished scope. Let already-running authorized work finish, collect its result, and check whether acceptance is now satisfied. A ticket that passes on its last permitted attempt is complete, not blocked.

If work remains, preserve its WIP and evidence, record the blocker, and pause that ticket plus its dependent frontier. Continue independent ready tickets under the user's existing authorization. Ask for direction only on the capped scope; stop the whole program only when no independent work remains or a genuine global constraint prevents it.

Every stop report names the ticket/integration ID, applicable threshold, counted run IDs and roles, exclusions, measured execution time if relevant, remaining defect, and the independent tickets still able to proceed. “Pipeline limit reached” alone is not a sufficient report.

## Capacity and cleanup are separate

Concurrency counts live workers only, under the configured runtime capacity. Reconcile run state with actual liveness: a watcher can fail while its external worker keeps running. Provider quotas and explicit monetary/token budgets are separate constraints and must be reported as such.

After collecting a terminal run's result or preserving its failure artifacts, terminate only its verified worker tmux session if it still exists. Preserve unrelated sessions and active workers. Keep commits and mailboxes. Cleanup frees live capacity; it does not refund substantive attempts or review rounds.

## Worked cases

- Thirteen independent tickets each use one writer: each ticket has one charged invocation, not thirteen.
- One writer plus three restarted watchers: one charged invocation. A pre-launch tmux failure adds zero.
- A writer commits code but its completion message is lost: recover the commit; that writer still counts.
- Ticket A remains defective at six charged invocations: pause A and its dependents; ready ticket B continues.
- A shared review of A and B is assigned to integration ticket I: charge one review to I, not one to each ticket.
- A six-attempt ticket succeeds on attempt six: verify and finish it; session cleanup does not require another attempt.
