<!-- o9k-provenance
who: cursor:grok-4.5
when: 2026-07-25T17:02:32.952Z
why: Document typed checkpoint + handoff_ready specialist mailbox protocol
trigger: mailbox worker RUNTIME_FIX2 production wiring
host: cursor
-->
# Worker task (mailbox protocol)

Run directory: `{{RUN_DIR}}`
Mailbox: `{{RUN_DIR}}/mailbox/`
Run id: `{{RUN_ID}}`

## Protocol (mandatory — parent is blocked on this)

The parent chat **cannot see your tmux pane**. It only wakes when mailbox
`STATUS` becomes `done`, `failed`, or `waiting_human`. Writing `PLAN.md` /
`RESULT.md` in the task cwd is **not enough** — you must close the mailbox.

1. On start: write `mailbox/STATUS` = `watching`. Touch `mailbox/HEARTBEAT` with UTC ISO now.
2. Every ~5 minutes of work (and after each meaningful step): update `HEARTBEAT`.
3. Need a human/parent decision: write `mailbox/QUESTIONS.md`, set `STATUS=waiting_human`, update HEARTBEAT, then wait for `mailbox/ANSWER.md` (do not exit).
4. Quota handoff (when `mailbox/CONTROL.json` has `type: request_handoff`):
   - Stop starting new work.
   - Write a typed `mailbox/CHECKPOINT.json` conforming to `team-up.checkpoint/v1`
     (`schema`, `run_id`, `attempt_id`, `status` complete|partial, `summary`,
     `completed`, `open`, `artifacts`, `verification_commands`, `risks`,
     `questions`, `repository`, `created_at`).
   - Set `handoff_ready: true` in `mailbox/CONTROL.json`.
   - Keep refreshing `HEARTBEAT` until the controller stops this session.
5. Finished:
   - Write task-dir artifacts (`PLAN.md`, `GRILL.md`, code, …) as required by the task.
   - Write `mailbox/RESULT.json` conforming to schema `team-up.result/v1`
     (`status`, `summary`, …). This is the live specialist mailbox protocol.
   - Optionally write `mailbox/RESULT.md` as human-readable detail (not sufficient alone).
   - Set `mailbox/STATUS` = `done` (or run: `team-up runs set-status {{RUN_ID}} done`).
   - Then you may stop.
6. Hard failure: `STATUS=failed` and explain in `mailbox/RESULT.json` (and optional RESULT.md).

Do **not** leave STATUS=`watching` after you finished the work. That traps the parent watcher forever.

## Task
{{TASK_BODY}}
