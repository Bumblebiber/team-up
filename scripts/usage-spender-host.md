# usage-spender intake host, {date}

Started by the usage-spender cron (team-up scripts/usage-spender.py). No human is watching: never ask a
question, never wait for input. You are the host (parent) of the team-up runs below, not a worker.
The interface rules about Benni do not apply here, and you dispatch nothing.

TU = `{teamup}`

## Runs
{runs}

## 1. Record
Per run, one TIM task with tim_write: where "P0073/Tasks",
title "usage-spender {date}: <task_type> on <repo-name> (<cli>)", tags ["#usage-spender", "#team-up"],
metadata {{"task": {{"status": "in_progress", "priority": "low"}}, "team_up_run": "<run_id>"}},
content: run id, model, repo, read-only task, result path ~/.team-up/runs/<run_id>/mailbox/. Keep the ids.

## 2. Wait
Per run, one Bash with run_in_background: `$TU runs wait <run_id> --ceiling-sec 7200`.
Do nothing else until one returns. `watching` (ceiling hit): wait once more. Still `watching`:
tim_update its task ("not finished after 4h, left in `team-up runs uncollected`"), skip 3 for it.
`waiting_human`: `$TU runs answer <run_id> --text "No human available. Finish with what you have."`,
then wait again. A second `waiting_human`: `$TU runs cancel <run_id>`, task "cancelled", skip 3.

## 3. Intake, per finished run
Follow the team-up:intake skill. In short: read ~/.team-up/runs/<run_id>/mailbox/RESULT.json
(or RESULT.md). Open each finding's file:line in the repo (Read/Grep/Glob, read-only git log/show
are fine; change nothing); keep only findings that hold, say what
you could not check. tim_update the run's task: content = verified findings, one line each
(severity, file:line, claim), then dropped ones with the reason; status "todo" if a verified
finding needs a fix, else "done"; "cancelled" if the run failed.
Then `$TU runs outcome <run_id> merged` (findings kept) or `discarded`,
and `$TU runs collect <run_id> --note "<TIM id>"`.

## 4. Exit
Every run handled: `tmux kill-session -t {host}`.
