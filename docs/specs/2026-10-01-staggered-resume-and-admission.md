# Staggered Resume and Admission Control

## Status

Plan 3 of 3, agreed in conversation 2026-10-01, not implemented. It needs
plan 1 (`2026-10-01-resource-telemetry-and-restart-report.md`) for the
verdict and the footprint numbers, and plan 2
(`2026-10-01-parent-session-recovery.md`) for the parent sessions it
schedules.

## Problem

`resumeAll` (`src/runs/runs.mjs`) walks every active run and executes every
action at once: all workers and all parents start within a second. If
team-up's load is what brought the server down, that replays the crash.
Nothing at normal launch time checks machine load either, so the same load
builds up again an hour later.

## Goals

- After a restart, sessions come back one at a time, each only when the
  machine has visibly absorbed the previous one.
- After a `team_up_suspected` restart, fewer sessions come back at once
  than were running before the crash. The rest wait, are resumed
  automatically when there is room, and the parent is told which runs are
  waiting.
- The same admission check guards every normal worker launch, so the
  crash is not rebuilt.
- Optionally, a per-worker memory ceiling, so a runaway worker is killed
  instead of the server.

## Non-goals

- CPU scheduling or priorities beyond start order.
- Pausing or killing running workers to make room. Admission only gates
  starts.
- Multi-host anything.

## Design

### Admission check

`src/admission/admission.mjs` exports `admit({ sample, footprint, limits,
running })`, a pure function returning `{ ok, reason, headroom }`:

A start is admitted when all of these hold:

1. `running.workers < limits.max_workers`
2. `sample.mem.MemAvailable - footprint.p95_rss_kb >= limits.reserve_kb`
   (after this worker starts, at least the reserve is left)
3. `sample.psi.memory.some.avg10 < limits.psi_some_max` (default 10) and
   `full.avg10 < limits.psi_full_max` (default 2); skipped when PSI is
   unavailable, with the reason recorded
4. swap use is not rising across the last three samples (a machine already
   swapping is not absorbing anything)

`limits.max_workers` defaults to
`floor((MemTotal * 0.7 - baseline_used_kb) / p95_rss_kb)`, where
`baseline_used_kb` is used memory with no team-up workers running (from
telemetry samples with `workers.length === 0`, median), and `p95_rss_kb`
comes from `workerFootprint()` (plan 1) for that worker's `cli`. Without
enough data (fewer than 20 worker samples), fall back to a conservative
configured value (default 2) and say so in the reason. Config overrides
everything: `admission.max_workers`, `admission.reserve_mb` (default 1024),
`admission.psi_some_max`, `admission.psi_full_max`.

The sample is taken live (`takeSample()` from plan 1), not read from the
log, so a decision never uses 30-second-old numbers.

### Resume as a queue

`resumeAll` stops executing actions inline. It builds the full plan (worker
actions from `buildResumePlan`, parent actions from plan 2's
`buildParentPlan`), then hands it to `src/admission/scheduler.mjs`:

**Order:**

1. Parent sessions. They are what the human talks to, and a parent with no
   running worker costs little. They count against the limit like workers
   (they are the same CLI binary). Measured separately in telemetry once
   plan 2 records them.
2. Runs in `waiting_human`. A human question is cheap to keep alive and
   expensive to lose.
3. Remaining worker restarts, oldest `createdAt` first: closest to done,
   most invested.

**Budget after the restart:**

- `clean_shutdown` or `other_cause`: `max_workers` as computed.
- `team_up_suspected`: `min(max_workers, floor(workers_last / 2))`, at
  least 1, where `workers_last` is from the restart report. The cap holds
  until the human lifts it (`team-up admission reset`) or 24 h pass without
  an admission refusal.
- `unknown`: `min(max_workers, workers_last)`. Do not grow past what was
  running before.

**Slow start:** before each next start the scheduler waits until

- the previous start's worker wrote its first `HEARTBEAT`
  (`mailbox/HEARTBEAT` mtime after its start) or 120 s have passed, and
- `admit()` passes on a fresh sample.

It polls every 5 s. A start whose session dies before its first heartbeat
is logged and does not block the queue.

**What does not fit:** the run moves to `waiting_capacity` with a new
reason, using the existing deferred-resume machinery in
`src/supervisor/waits.mjs`:

```json
"capacity": {
  "reason": "resources",
  "auto_resume": true,
  "resume_not_before": "<now + 2 min>",
  "admission": { "reason": "MemAvailable 1.2 GB < reserve after start", "verdict": "team_up_suspected" },
  "wait_cancelled": false,
  "available_actions": ["cancel-wait", "recheck-capacity", "cancel"]
}
```

`resumeDueWaits` already restarts due waits through
`startFromLaunchDescriptor`. It gets one more gate: for `reason:
"resources"`, call `admit()` first and push `resume_not_before` forward by
2 minutes on refusal. Since `resumeDueWaits` runs from `runs resume`, the
GC timer (every 5 min, plan 1's timer pattern) must also call it, or a
deferred run waits for the next reboot. Check whether
`team-up-gc.service` already reaches it; if not, add a step.

The parent wake-up message (plan 2) lists deferred runs as such, so the
parent does not dispatch them again.

### The scheduler runs detached

A boot-time resume that sleeps through a slow start for several minutes
must not hold `systemctl`. `team-up-resume.service` (plan 2) starts `runs
resume`, which writes the queue to `~/.team-up/resume-queue.json`, then
executes it in the same process with the resume lock held. The unit is
`Type=simple` and has `TimeoutStartSec=infinity` for that reason. A second
`runs resume` while one is running sees the lock and prints the queue
status instead (`acquireResumeLock` already steals from a dead PID).

### Admission at normal launch

`launcher.mjs`, after profile resolution and before `createRun`: take a
sample and call `admit()`.

- Refused and the caller passed `--wait-capacity` (or the supervisor path
  is in use): create the run directly in `waiting_capacity` with `reason:
  "resources"`, same as quota exhaustion is handled today.
- Refused otherwise: fail with `ADMISSION_REFUSED: <reason>` and exit code
  3, so the parent can decide. Do not silently queue a run the parent
  thinks is running.
- `--force-admission` bypasses the check, records it in state, and is what
  a human uses when they know better.

`pipeline` fan-out (N Codeys at once) is where this bites. The `pipeline`
skill gains one line: dispatch sequentially and expect `ADMISSION_REFUSED`
or `waiting_capacity` for the tail.

### Per-worker memory ceiling (optional, measured first)

When a worker runs under `systemd-run --user`, add
`-p MemoryHigh=<p95*1.5>` and `-p MemoryMax=<p95*2>` (configurable,
`admission.memory_max_factor`). Then the kernel OOM-kills one worker in its
own cgroup instead of taking the server down, and the run fails with a
clear reason.

Preconditions, verified before it is enabled:

- the user manager has the memory controller delegated:
  `cat /sys/fs/cgroup/user.slice/user-$UID.slice/user@$UID.service/cgroup.controllers`
  contains `memory`
- the worker actually runs under `systemd-run`. That is best-effort today:
  launch falls back to no sandbox when the semantic probe fails
  (`docs/specialists.md`), and Ubuntu 24.04's userns restriction is one
  documented cause. A ceiling that silently does not apply is worse than
  none, so record `sandbox.memory_max_applied: true|false` in state, and
  have `doctor` report the count of unconstrained workers.

`team-up doctor` checks the delegation and reports whether ceilings are
possible on this host.

## Files

- new `src/admission/admission.mjs` (`admit`, limit derivation),
  `src/admission/scheduler.mjs` (queue, order, slow start, deferral)
- `src/runs/runs.mjs`: `resumeAll` builds the plan and delegates;
  `admission reset` command
- `src/supervisor/waits.mjs`: `reason: "resources"` gate in
  `resumeDueWaits`
- `src/runs/gc.mjs` or the GC service: call `resumeDueWaits`
- `src/specialists/launcher.mjs`: admission before `createRun`,
  `--force-admission`
- `src/sandbox/systemd.mjs`: `MemoryHigh`/`MemoryMax` properties
- `src/doctor.mjs`: cgroup delegation, unconstrained workers
- `skills/pipeline/SKILL.md`, `skills/dispatch/SKILL.md`:
  `ADMISSION_REFUSED` handling
- `docs/configuration.md`: `admission.*` keys

## Tests

- `admit()`: table test over planted samples: each rule refusing alone,
  PSI missing, insufficient footprint data → fallback limit
- limit derivation from planted telemetry, per cli
- scheduler with a fake clock and fake starts:
  - order: parents, `waiting_human`, then oldest first
  - `team_up_suspected` with 6 workers before the crash → 3 started, 3
    deferred with `reason: "resources"`
  - slow start waits for HEARTBEAT, times out at 120 s, does not stall on
    a dead start
  - `unknown` verdict does not exceed the pre-crash count
- `resumeDueWaits` defers a resources wait when `admit()` refuses and
  starts it when it passes
- launcher: refusal → `ADMISSION_REFUSED` exit 3; with the wait flag →
  `waiting_capacity`; `--force-admission` recorded
- systemd argv contains the memory properties only when enabled

## Acceptance criteria

- After a forced reboot with 6 workers and a `team_up_suspected` verdict:
  3 come back one after another, each after the previous one's heartbeat;
  3 wait in `waiting_capacity` and start on their own as memory allows; the
  parent's message lists which is which.
- Launching a seventh worker on a machine under memory pressure returns
  `ADMISSION_REFUSED` with the measured reason, not a crash an hour later.
- With ceilings enabled and delegation present, a worker exceeding
  `MemoryMax` is killed alone and its run fails with a reason naming the
  limit.

## Open questions

- Should parents count against the same limit as workers, or get a
  separate small budget so a human's session is never the one deferred?
  The current proposal: same limit, but parents are always first in line.
- Default `reserve_mb`: 1 GB is a guess. Set it from a week of plan 1 data.
