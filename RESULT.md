# RESULT — codex reset timezone + cursor collect

## Outcome

**done** — both bugs fixed, live collection verified, tests green 5/5.

## Commits

- `b3db415` — fix(usage): codex reset timezone + cursor PTY slash autocomplete
- Base: `94a39b6`

## 1. Codex reset timezone

**Problem:** `parseCodexResetUtc()` used `Date.UTC(...)`, but codex prints reset times in local wall time. On this host (Europe/Berlin, CEST) that stored UTC 2h late — limit watcher thought quota was active 2h after actual reset.

**Fix:** Renamed to `parseCodexResetLocal()`, routes through existing `zonedWallTimeToUtc()` with `Intl.DateTimeFormat().resolvedOptions().timeZone`. Optional `opts.timeZone` on `parseResetAt()` for tests.

**Live output:**
```
ok codex: codex:weekly
```
```json
{
  "resets_at_raw": "14:28 on 4 Aug",
  "resets_at": "2026-08-04T12:28:00.000Z"
}
```
(14:28 CEST → 12:28Z — was incorrectly 14:28Z before fix.)

## 2. Cursor `--cli cursor`

**Root cause (two issues):**
1. **Small PTY** — default expect spawn rendered one character per line (same class of bug as codex). Fixed with 120×40 PTY + `$HOME` cwd.
2. **Slash autocomplete** — sending `/usage\r` in one shot opens the autocomplete menu but Enter fires before `autoExecuteOnAccept` is ready; command never runs. Fixed by slow-typing `/` then `usage`, waiting for `Show plan`, then Enter.

**Live output:**
```
ok cursor: cursor:included, cursor:auto, cursor:api
```
```json
{
  "cursor:included": { "used": 0.09, "source": "cursor:/usage" },
  "cursor:auto":     { "used": 0.08, "source": "cursor:/usage" },
  "cursor:api":      { "used": 0.12, "source": "cursor:/usage" }
}
```

## npm test (5 runs)

```
ℹ tests 316 ℹ pass 316 ℹ fail 0
ℹ tests 316 ℹ pass 316 ℹ fail 0
ℹ tests 316 ℹ pass 316 ℹ fail 0
ℹ tests 316 ℹ pass 316 ℹ fail 0
ℹ tests 316 ℹ pass 316 ℹ fail 0
```

## Deviations

None.

## Supervisor decisions

None required.

## Decision-Log Data

```
## Decision-Log Data
task_type: bugfix
lane: standard
agents_used: cursor:grok-4.5
review_cycles: 0
outcome: done
notable: cursor /usage needs slow-type for slash autocomplete; codex resets are local wall time not UTC
```
