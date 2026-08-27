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

**Every mailbox path below is absolute on purpose.** Your working directory is
not the run directory, so a relative mailbox path writes a second mailbox that
nothing reads — you would report `done` and the parent would wait forever.
Run id: `{{RUN_ID}}`

## Protocol (mandatory — parent is blocked on this)

The parent chat **cannot see your tmux pane**. It only wakes when mailbox
`STATUS` becomes `done`, `failed`, or `waiting_human`. Writing `PLAN.md` /
`RESULT.md` in the task cwd is **not enough** — you must close the mailbox.

1. On start: write `{{RUN_DIR}}/mailbox/STATUS` = `watching`. Touch `{{RUN_DIR}}/mailbox/HEARTBEAT` with UTC ISO now.
2. Every ~5 minutes of work (and after each meaningful step): update `HEARTBEAT`.
3. Need a human/parent decision: write `{{RUN_DIR}}/mailbox/QUESTIONS.md`, set `{{RUN_DIR}}/mailbox/STATUS` = `waiting_human`, update HEARTBEAT, then wait for `{{RUN_DIR}}/mailbox/ANSWER.md` (do not exit).
4. Quota handoff (when `{{RUN_DIR}}/mailbox/CONTROL.json` has `type: request_handoff`):
   - Stop starting new work.
   - Write a typed `{{RUN_DIR}}/mailbox/CHECKPOINT.json` conforming to `team-up.checkpoint/v1`
     (`schema`, `run_id`, `attempt_id`, `status` complete|partial, `summary`,
     `completed`, `open`, `artifacts`, `verification_commands`, `risks`,
     `questions`, `repository`, `created_at`).
   - Set `handoff_ready: true` in `{{RUN_DIR}}/mailbox/CONTROL.json`.
   - Keep refreshing `HEARTBEAT` until the controller stops this session.
5. Finished:
   - Write task-dir artifacts (`PLAN.md`, `GRILL.md`, code, …) as required by the task.
   - Write `{{RUN_DIR}}/mailbox/RESULT.json` conforming to schema `team-up.result/v1`
     (`status`, `summary`, …). This is the live specialist mailbox protocol.
     `status` must be exactly one of `success`, `partial`, `blocked`, `failed` —
     any other value (including `done`) fails the run. `done` is the value for
     `{{RUN_DIR}}/mailbox/STATUS` in the next step, not for `RESULT.json`.
   - Optionally write `{{RUN_DIR}}/mailbox/RESULT.md` as human-readable detail (not sufficient alone).
   - Set `{{RUN_DIR}}/mailbox/STATUS` = `done` (or run: `team-up runs set-status {{RUN_ID}} done`).
   - Then you may stop.
6. Hard failure: `{{RUN_DIR}}/mailbox/STATUS` = `failed` and explain in `{{RUN_DIR}}/mailbox/RESULT.json` (and optional RESULT.md).

The parent may write `mailbox/VERIFICATION.json` after you close the mailbox — that file is
**parent-owned evidence**, not yours to author. Do not write or rely on it.

Do **not** leave STATUS=`watching` after you finished the work. That traps the parent watcher forever.

## Task
{{TASK_BODY}}
