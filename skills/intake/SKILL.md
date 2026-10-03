---
name: intake
description: "Lift finished specialist results out of the mailbox: read, check against evidence, decide, record in memory, mark collected. Use when a watcher returns done or failed, when the user asks what came back, and at the start of a session that may have inherited results (`team-up runs uncollected`). Host session only."
metadata:
  team-up-scope: main
---

# intake — results in, memory out

A run is not finished when its mailbox says `done`. It is finished when the
host session has read the result, acted on it and — if anything in it is
worth keeping — written that down. Until then the result is only on disk,
and a session that dies before this step leaves it there unread.

Only the host session runs this. Specialists never write memory and never
mark themselves collected.

## 1. Find what is waiting

```bash
team-up runs uncollected            # done/failed in the last 7 days, not yet collected
team-up runs uncollected --all      # no age window
```

Exit 1 means something is waiting. Run it at session start as well as after a
watcher returns: the previous session may have died between the two.

## 2. Read the result, not the summary of it

For each run, read `~/.team-up/runs/<id>/mailbox/RESULT.json`
(`team-up.result/v1`): `status`, `summary`, `deliverables`, `evidence`,
`risks`, `questions`. Generic Path-B runs leave `RESULT.md` instead.

- `questions` non-empty → those go to the user before anything else.
- `status: partial|blocked` → say what is missing; do not round it up.
- `risks` → carry each one forward or dismiss it with a reason. Never drop one
  silently.

## 3. Check it against evidence

`summary` is a claim. Before you act on it:

- A delegate run's diff: `git -C <cwd> diff <base_commit>`, both values from
  the run's `STATE.json`.
- Tests the result says pass: if the run has a `verify` command, read
  `verification` in the run's `STATE.json`. `verdict: pass|fail` is the answer.
  The tool already matched its `status_mtime_ms` to the mailbox `STATUS` write
  it verified, so read `verdict` / `pending` and do not compare mtimes by hand.
  No `verification`, or `pending: true`, means unverified: run
  `team-up runs wait <id>` once (it verifies a pending done for the record),
  then read it again. Still no `verdict` → report the run as unverified. Never
  treat it as passing. `mailbox/VERIFICATION.json` holds the per-run detail but
  the worker can overwrite it. Without a `verify` command, run the project's
  own check yourself. A worker's own "tests pass" is not evidence.
- Files named in `deliverables`: confirm they exist and say what is claimed.

What you could not check, say you could not check.

## 4. Decide

- Code you keep or drop → `team-up runs outcome <id> merged|discarded`.
- A follow-up the result calls for → dispatch it (see `dispatch`, `pipeline`);
  put the facts it needs in the request's `inputs`, not in a memory tool the
  specialist does not have.

## 5. Memory — curated, once, by you

If a memory MCP is connected (TIM or another), write **one** entry per run
that changed what is true about the project: a decision, a confirmed cause, a
measured number, a dead end worth not repeating.

- Write the conclusion, not the transcript. The mailbox already is the raw
  record; link it by run id instead of copying it.
- Keep the evidence and the uncertainty: "measured", "inferred", "not
  verified" survive into the entry.
- A routine result that changes nothing gets no entry.

## 6. Mark it collected

```bash
team-up runs collect <id> --note "merged; TIM entry <id>"   # or "read; nothing durable"
```

This is what takes the run off the `uncollected` list. Collect a run only
after steps 2–5, never as a way to clear the list.
