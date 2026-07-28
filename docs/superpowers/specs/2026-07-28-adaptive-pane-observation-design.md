# Adaptive pane observation

Status: approved (supervisor, 2026-07-28). Replaces the per-CLI startup
classifier approach on `feature/supervisor-startup-notification`.

## Problem

`waitMailbox()` blocks on `scripts/wait-mailbox.sh`, which waits for inotify
events on the mailbox directory. A worker that is stuck — trust dialog, model
picker, a question typed into the TUI instead of `QUESTIONS.md`, a crashed
process — writes nothing. No event fires. The parent waits out the full
ceiling (default 3600 s) and only then learns something went wrong.

The previous attempt fixed this with hand-written per-CLI string classifiers.
Two things killed it: only one of five CLIs ever got a classifier, and the
strings rot. The marker the plan relied on (`→ Add a follow-up` as an idle
signal for cursor-agent) is provably wrong — it is the input-box placeholder
and shows in **both** states; see
`test/fixtures/panes/cursor-agent/working-followup-placeholder.txt`, where it
appears next to `⠠⠛ Running`, distinguished only by a trailing
`ctrl+c to stop`.

## Approach

Do not classify panes with patterns. Poll the pane; when it stops changing,
hand the text to a model and let it judge. Code never trusts that judgement
blindly — it verifies every proposed action before executing it.

## The loop

- Poll `tmux capture-pane -pJ` every **5 s** (`poll_sec`).
- Compare against the previous capture. Compare the **raw** text with only
  trailing whitespace per line trimmed. Do **not** strip spinners, token
  counters or elapsed timers — those are exactly the liveness signal. A
  cursor-agent that is working animates `⠠⠛ Running 31 tokens`; that pane is
  never identical twice, so it never trips the stall detector.
- **3 consecutive identical captures** (`stall_ticks`, ≈15 s of a frozen
  screen) → one judge call. Not every tick: one call per stall episode.
- After a judge call, reset the counter. A pane that changes and freezes again
  is a new episode.

Both values are config with these defaults, overridable per run.

## The judge

One non-interactive model call. Input: the last capture (bounded to the final
~8 KiB), the CLI name, the run id, elapsed time since dispatch, and the run's
role. Output: strict JSON.

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

**The judge must not be `claude`.** Judging is a one-shot call and
`claude -p` is banned by the operator's standing rules. Use a non-interactive
CLI that supports print mode. Add a roster role:

```json
"observer": { "chain": ["cursor:grok-4.5-high", "codex:gpt-5.4-mini"] }
```

Hard timeout 60 s per call.

## Verification — code decides, not the model

The model proposes; code approves, downgrades, or drops. Never execute a
proposal because it came back well-formed.

1. `action: "answer"` is only honoured when every element of `keys` is in a
   fixed allowlist of navigation and confirmation keys: `Enter`, `Escape`,
   `Up`, `Down`, `Left`, `Right`, `Tab`, `Space`, `y`, `n`, and single digits
   `1`–`9`. **No free text ever.** Anything else → downgrade to `escalate`.
2. If the pane matches a deny pattern — login, sign in, authenticate, device
   code, verification code, API key, token, password, billing, payment,
   subscribe, upgrade plan — → `escalate`, whatever the model said. Credentials
   and money are never answered automatically.
3. Never answer the same normalized pane twice in one run: keeps a mistaken
   answer from becoming a loop.
4. At most **3** auto-answers per run; the fourth stall escalates.
5. Judge error, timeout, non-JSON, or unknown `state` → `escalate` once,
   flagged so it does not repeat every tick.

Every judge verdict and every code decision (honoured / downgraded, with the
reason) is appended to `<mailbox>/OBSERVATION.log` as one JSON object per
line. This is the audit trail; an auto-answer that is never explained is a
defect.

## Escalation

Escalation reuses what already exists — no new notification channel:

- write the question to `<mailbox>/QUESTIONS.md`
- set `<mailbox>/STATUS` to `waiting_human`

The running `wait-mailbox.sh` sees the write via inotify and wakes the parent
exactly as it does for a worker-authored question.

## Where it runs

`waitMailbox()` spawns the observer as a background child before it spawns
`wait-mailbox.sh`, and kills it in a `finally` once the wait returns. The bash
wait is not modified — the observer only has to *cause* a mailbox write, and
the existing wake path does the rest. The two processes share the parent's
lifetime, which is the same coupling the watcher already has today.

## Non-goals

- No new daemon, no cron, no long-lived service.
- No per-CLI pattern classifiers. `getStartupClassifier` and friends on
  `feature/supervisor-startup-notification` are not carried over.
- Not a productivity monitor: the loop reacts to a frozen screen, and says
  nothing about whether the work is any good.
