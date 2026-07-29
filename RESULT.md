# Round 3 fix: escalation ceiling on stuck, not silence trigger

## Outcome

**done** — stall-episode ceiling now applies to all triggers (`pane`, `both`,
`silence`), resets on mailbox progress, and escalates after 3 judge episodes.
Healthy heartbeating workers are no longer false-woken. `DEFAULT_SILENCE_SEC`
raised to 900. Config knobs wired via env / `waitMailbox` options. Design doc
rewritten.

## Commits

- `48f3193` — core fix (observe.mjs, runs.mjs, tests, design doc, mutate script)
- `af73e1d` — stabilize trigger-change mutation test

Branch: `feature/adaptive-pane-observation` (was `d820b04`)

## Repro before / after

### rA — frozen pane + dead mailbox, judge always `wait`

**Before:** STATUS=watching, 2 judge calls, no escalation in 20s
```
RA STATUS: watching
RA QUESTIONS.md exists: false
RA judge calls: 2
```

**After:** STATUS=waiting_human after 3 judge calls (~4.8s)
```
RA STATUS: waiting_human
RA QUESTIONS.md exists: true
RA judge calls: 3
```

### rB — moving pane, heartbeat every 5s, silenceSec=2

**Before:** false wake at 4.2s
```
RB STATUS: waiting_human
RB QUESTIONS.md exists: true
RB judge calls: 2
```

**After:** no false wake in 20s
```
RB STATUS: watching
RB QUESTIONS.md exists: false
RB judge calls: 8
```

### rC — heartbeat every 3s (1.5× silenceSec)

**Before:**
```
RC STATUS: waiting_human
RC falsely woke a human: true
RC judge calls: 2
```

**After:**
```
RC STATUS: watching
RC falsely woke a human: false
RC judge calls: 10
```

### rF — scratchpad uses `waiting_input` + `escalate` (not `working`)

**Before / after (scratchpad unchanged):** immediate escalate — correct per R3
(deferral applies only to `working`/`finished` + fresh mailbox).

```
RF STATUS: waiting_human
RF woke a human: true
RF judge calls: 1
```

**Working-state deferral (separate run, silenceSec=2, 6s):** 1st call deferred
(STATUS=watching), 2nd honoured (STATUS=waiting_human). Covered by unit test
`working escalate with fresh mailbox is deferred then honoured on repeat`.

### rG — alternating fresh/stale on frozen pane

**Before:** 13 judge calls / 20s
```
RG judge calls: 13
RG STATUS: watching
```

**After:** 10 judge calls / 20s (23% reduction, no false wake)
```
RG judge calls: 10
RG STATUS: watching
```

## Test suite ×10

```
ℹ tests 47 ℹ pass 47 ℹ fail 0 
ℹ tests 47 ℹ pass 47 ℹ fail 0 
ℹ tests 47 ℹ pass 47 ℹ fail 0 
ℹ tests 47 ℹ pass 47 ℹ fail 0 
ℹ tests 47 ℹ pass 47 ℹ fail 0 
ℹ tests 47 ℹ pass 47 ℹ fail 0 
ℹ tests 47 ℹ pass 47 ℹ fail 0 
ℹ tests 47 ℹ pass 47 ℹ fail 0 
ℹ tests 47 ℹ pass 47 ℹ fail 0 
ℹ tests 47 ℹ pass 47 ℹ fail 0 
```

(47 tests; was 41 before new integration/mutation-driven cases.)

## Mutation results (`scripts/mutate-observe.sh`)

| Mutation | Result |
|----------|--------|
| M1 never increment stallEpisodeCount | caught (3–4 failing) |
| M2 ceiling never fires | caught |
| M3 key-count cap removed | caught |
| M4 observer files in mailbox age | caught |
| M5 trigger latch not cleared | caught |
| M6 mailbox progress never resets counter | caught |
| M7 deny-pattern removed | caught |
| M8 post-answer stall removed | caught |
| M9 working escalate deferral removed | caught |

**No surviving mutations on escalation path.**

## Deviations / notes

1. **rF scratchpad** uses `state: waiting_input`, not `working`. R3 deferral is
   implemented and tested; scratchpad behaviour is unchanged and intentional
   for that state.
2. **rG judge calls** dropped 13→10 but still ~1 per stale window on a
   heartbeating worker. Counter resets prevent ceiling escalation; further
   reduction would require skipping pane-only judge calls on fresh mailbox
   (would break trust-dialog-on-fresh-mailbox path).
3. **rB** still makes judge calls during silence gaps before heartbeat arrives;
   they no longer accumulate to false escalation.
4. Deleted stale root `RESULT.md` from prior round (was untracked delete in git status).

## Decision required

None — all rulings implemented as specified.

## Decision-Log Data

```
## Decision-Log Data
task_type: bugfix
lane: standard
agents_used: cursor:grok-4.5
review_cycles: 3
outcome: done
notable: Replaced silence-only ceiling with per-run stallEpisodeCount on all triggers; DEFAULT_SILENCE_SEC 120→900
```
