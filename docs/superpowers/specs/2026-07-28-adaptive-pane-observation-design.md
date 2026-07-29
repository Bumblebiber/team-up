# Adaptive pane observation

Status: approved (supervisor, 2026-07-28). Updated 2026-07-29 for mailbox-age
control path, stall-episode ceiling, and observer configuration.

## Problem

`waitMailbox()` blocks on `scripts/wait-mailbox.sh`, which waits for inotify
events on the mailbox directory. A worker that is stuck — trust dialog, model
picker, a question typed into the TUI instead of `QUESTIONS.md`, a crashed
process — writes nothing. No event fires. The parent waits out the full
ceiling (default 3600 s) and only then learns something went wrong.

The previous attempt fixed this with hand-written per-CLI string classifiers.
Two things killed it: only one of five CLIs ever got a classifier, and the
strings rot.

## Approach

Do not classify panes with patterns. Poll the pane; when it stops changing,
hand the text to a model and let it judge. Code never trusts that judgement
blindly — it verifies every proposed action before executing it.

Mailbox age is the dominant liveness signal. A frozen terminal screen is not
evidence of idleness when the worker is still writing mailbox files.

## The loop

- Poll `tmux capture-pane -pJ` every **5 s** (`poll_sec`, default
  `DEFAULT_POLL_SEC`). Overridable via `TEAM_UP_OBSERVER_POLL_SEC` /
  `O9K_OBSERVER_POLL_SEC`, or `waitMailbox({ pollSec })`.
- Compare against the previous capture. Compare the **raw** text with only
  trailing whitespace per line trimmed. Do **not** strip spinners, token
  counters or elapsed timers.
- **Pane stall:** 3 consecutive identical captures (`stall_ticks`, ≈15 s of a
  frozen screen).
- **Silence stall:** no worker-owned mailbox file has been modified for
  `silence_sec` (default **900 s** / 15 min, `DEFAULT_SILENCE_SEC`). This sits
  above the worker protocol's ~5-minute heartbeat cadence. Overridable via
  `TEAM_UP_OBSERVER_SILENCE_SEC` / `O9K_OBSERVER_SILENCE_SEC`, or
  `waitMailbox({ silenceSec })`.
- Either stall condition opens a **stall episode**. One judge call per episode,
  throttled to at most one call per `silence_sec` across all triggers.

### Stall triggers

| Trigger | Pane stalled | Mailbox stale |
|---------|--------------|---------------|
| `pane`  | yes          | no            |
| `silence` | no         | yes           |
| `both`  | yes          | yes           |

Episode latch uses `trigger` as the episode key. When the trigger changes, the
episode re-opens and a new judge call may fire (subject to throttle).

### Stall-episode ceiling

A per-run `stallEpisodeCount` increments on every judge call (all triggers).
It resets when mailbox age drops — the worker wrote something.

After **3** consecutive stall episodes (`MAX_STALL_EPISODES`) with no worker
progress in between, the observer escalates unconditionally, regardless of
trigger or judge verdict. This replaces the old silence-only ceiling.

### Observer pidfile

`waitMailbox()` spawns `observe.mjs` as a background child. The observer
acquires an exclusive lock at `<mailbox>/OBSERVER.pid` so only one observer
runs per run. A second spawn exits immediately. The lock is released on
observer exit; stale locks from dead PIDs are replaced on takeover.

`OBSERVATION.log` and `OBSERVER.pid` are excluded from mailbox-age
calculation so the observer does not treat its own writes as worker progress.

## The judge

One non-interactive model call per stall episode. Input: the last capture
(bounded to ~8 KiB), CLI name, run id, role, elapsed time, `mailbox_age_sec`,
and `silence_sec`. Output: strict JSON.

```json
{
  "state": "working|waiting_input|finished|crashed|login_required|unknown",
  "reason": "one sentence",
  "action": "wait|answer|escalate",
  "keys": ["Down", "Enter"],
  "question": "text for the supervisor when action=escalate",
  "evidence": "the pane lines the verdict rests on, quoted"
}
```

**The judge must not be `claude`.** Roster role:

```json
"observer": { "chain": ["cursor:grok-4.5-high", "codex:gpt-5.4-mini"] }
```

Hard timeout 60 s per call.

## Verification — code decides, not the model

1. `action: "answer"` only when every key is allowlisted, ≤8 keys, mailbox is
   stale (`mailbox_age_sec >= silence_sec`), deny patterns do not match, pane
   not already answered, and auto-answer cap not reached. A **fresh mailbox**
   downgrades `answer` to `wait` even on a frozen pane.
2. Deny patterns block auto-answer only, not `wait` or `escalate`.
3. Never answer the same normalized pane twice in one run.
4. At most **3** auto-answers per run.
5. Judge error / timeout / non-JSON / unknown `state` → escalate once.
6. **`escalate` deferral:** when the judge proposes `escalate` with state
   `working` or `finished` and the mailbox is fresh, log the verdict and defer
   once (treat as `wait`). Honour on the next episode if the judge repeats.
   `login_required`, `crashed`, `unknown`, stale-mailbox escalates, and
   `waiting_input` escalates are honoured immediately.

Every verdict and code decision is appended to `<mailbox>/OBSERVATION.log`.

## Escalation

- write the question to `<mailbox>/QUESTIONS.md`
- set `<mailbox>/STATUS` to `waiting_human`

`wait-mailbox.sh` wakes the parent via inotify.

## Where it runs

`waitMailbox()` spawns the observer before `wait-mailbox.sh` and kills it in
`finally`. Pass `pollSec` / `silenceSec` to tune the child; they become
`TEAM_UP_OBSERVER_*` environment variables read by `observe.mjs`.

## Non-goals

- No new daemon, cron, or long-lived service.
- No per-CLI pattern classifiers.
- Not a productivity monitor.
