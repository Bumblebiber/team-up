# Resource Telemetry and Restart Report

## Status

Plan 1 of 3, agreed in conversation 2026-10-01, implemented 2026-10-01 (`src/telemetry/`). Plans 2
(`2026-10-01-parent-session-recovery.md`) and 3
(`2026-10-01-staggered-resume-and-admission.md`) build on the data this one
records. Ship this first: without measurements there is nothing to base a
restart verdict or a concurrency limit on.

Where the implementation departs from the design below:

- CPU is `cpu_ms` (ticks at USER_HZ 100, or the cgroup's `usage_usec`), so
  tmux and cgroup workers share one unit. Each worker row also carries
  `comms`, the process names, for matching OOM victims.
- PSI records `avg60` beside `avg10`: a 30 s sampler can miss a 10 s spike.
- A sandboxed worker's unit is `team-up-<runId>-<base36 start time>`, so a
  restart within one boot cannot collide with a unit systemd has not
  collected yet. `state.sandbox.unit` holds it with the `.service` suffix.
  Its `rss_kb` is the RSS sum of `cgroup.procs`, comparable with tmux
  workers; `memory.current` (which includes page cache) is kept as
  `cgroup_kb`.
- The journal is asked for the previous boot by the `boot_id` the telemetry
  recorded (`-b <id>`), not `-b -1`, so the evidence and the samples describe
  the same boot.
- The share that decides the verdict is team-up's at the sample with the
  least `MemAvailable` in the window, not at the last sample: workers the OOM
  killer already took are missing from the last one. An OOM victim matched
  to a worker (by pid, or by unit name in its cgroup) makes the verdict
  `team_up_suspected` on its own. A kill inside a memory ceiling
  (`CONSTRAINT_MEMCG`) is recorded as `contained` and is not exhaustion.
- With only the user journal readable, an orderly stop of the user manager
  counts as a clean shutdown, and the report says that a logout reads the
  same.
- No telemetry from an earlier boot returns no report (`null`), not
  `unknown`: on a fresh install there is nothing to judge, and plan 3 must
  not cap a resume on it.
- Retention runs on every sample; it is one `readdir`.
- `workerFootprint` also returns `baseline_used_kb`, the median used memory
  with no worker running, which plan 3's limit needs.
- `parents[]` came with plan 2: each live registered session's process tree, kept out of `team_up_rss_kb`.

## Problem

When the server has to be restarted, nobody can say afterwards whether
team-up caused it. team-up records nothing about machine load: no memory, no
pressure, no per-worker footprint (`grep -r "meminfo\|/proc/pressure" src`
finds nothing). Plan 3 has to throttle a resume after a team-up-caused
crash, so it needs both the numbers and a verdict.

## Goals

- A cheap, continuous record of system load and of team-up's share of it,
  which survives a crash up to the last sample.
- After every boot, a report that says whether the previous boot ended
  cleanly, crashed, or crashed with team-up as the likely cause, and why.
- Per-worker footprint statistics (p50/p95 RSS) that plan 3 can use to size
  limits.

## Non-goals

- Not a monitoring system. No dashboards beyond one optional panel, no
  alerting, no remote shipping.
- No certainty. A hard freeze leaves no last log line; the verdict is a
  heuristic and says so.
- No root. Everything runs as the user; missing privileges degrade the
  verdict to `unknown` instead of failing.

## Design

### Sampler

`src/telemetry/sample.mjs` exports `takeSample({ now, procRoot = "/proc",
listWorkers })` and returns a plain object. All reads go through `procRoot`
so tests can plant a fake `/proc`.

Fields per sample:

| Field | Source |
|---|---|
| `at` | ISO time |
| `boot_id` | `/proc/sys/kernel/random/boot_id` |
| `uptime_s` | `/proc/uptime` |
| `load` | `/proc/loadavg` (1/5/15) |
| `mem` | `/proc/meminfo`: `MemTotal`, `MemAvailable`, `SwapTotal`, `SwapFree` (kB) |
| `psi` | `/proc/pressure/{memory,cpu,io}`: `some.avg10`, `full.avg10` (absent → `null`, older kernels) |
| `workers` | one row per live team-up worker: `runId`, `tmux`, `rss_kb`, `cpu_ticks`, `pids` |
| `team_up_rss_kb` | sum of `workers[].rss_kb` |

**Finding worker processes.** For each active run (`listActiveStates()`)
with `worker.tmux`, get the pane PID via `tmux list-panes -t <s> -F
'#{pane_pid}'` and walk descendants through `/proc/<pid>/task/*/children`
(fall back to scanning `/proc/*/stat` for ppid). Sum `VmRSS` from
`/proc/<pid>/status` and `utime+stime` from `/proc/<pid>/stat`. When the
worker runs under `systemd-run --user` (`state.sandbox.kind ===
"systemd-run-user"`), its processes are not tmux descendants: read the
unit's cgroup instead (`systemctl --user show -p ControlGroup <unit>`, then
`memory.current` and `memory.peak` under `/sys/fs/cgroup<path>`). The
launcher must therefore record the unit name in state; today `systemd-run`
gets no `--unit`, so add `--unit=team-up-<runId>` in
`src/sandbox/systemd.mjs` (the name must be unique and valid; check how
long run ids get).

Parent sessions (plan 2) are counted the same way once their tmux name is
known, as `parents[]` with the same fields, so the report can tell "five
workers" from "five workers plus three orchestrating sessions".

### Storage

- `~/.team-up/telemetry/YYYY-MM-DD.jsonl`, one JSON object per line.
- Append with `fs.appendFileSync` followed by `fsync` on the fd. A sample
  that is not on disk when the machine dies is worthless, and one fsync
  every 30 s costs nothing.
- Retention: delete files older than 7 days (configurable,
  `telemetry.retention_days` in config). The sampler does it once a day.
- A sample line is about 300 bytes plus about 120 per worker, so a day at
  30 s with 5 workers is under 3 MB.

### Schedule

A systemd user timer, installed the way `installGcTimer` installs the GC
timer (`src/runs/gc-timer.mjs`): `team-up-telemetry.service` (oneshot,
`team-up telemetry sample`) and `team-up-telemetry.timer` with
`OnBootSec=30s`, `OnUnitActiveSec=30s`, `AccuracySec=5s`. Command:
`team-up telemetry install-timer`, mirroring `runs gc-install`. Document
`loginctl enable-linger $USER`, without which user timers stop at logout.

A timer instead of a daemon: no process to supervise, and a stuck sample
cannot take the next one with it.

### Restart report

`src/telemetry/restart.mjs` exports `analyzeRestart({ telemetryDir, procRoot,
journal })` and runs at the start of `team-up runs resume` (and as `team-up
telemetry restart-report` on its own).

1. **Was there a restart?** Compare the current `boot_id` with the
   `boot_id` of the last sample on disk. Equal means no restart, return
   `null`. Write the report at most once per boot (key the file by
   `boot_id`).
2. **How did the previous boot end?** `journalctl --user`-independent
   sources, in order:
   - `journalctl -b -1 -o json --output-fields=MESSAGE,_SYSTEMD_UNIT -n 200`:
     a "Reached target System Shutdown" or "Power-Off" near the end means an
     orderly shutdown.
   - `last -x -F shutdown reboot` as a fallback.
   - If neither is readable (no `systemd-journal`/`adm` group membership):
     `shutdown: "unknown"`, with the reason recorded.
3. **Was it memory?** `journalctl -k -b -1 --grep 'Out of memory|oom-kill|
   invoked oom-killer'` plus `journalctl -b -1 -u systemd-oomd`. Record the
   killed process names and whether any belonged to a team-up worker (match
   by name and by the last sample's PIDs).
4. **What did the last samples show?** Take the samples from the previous
   `boot_id` covering its last 10 minutes:
   - minimum `MemAvailable / MemTotal`
   - maximum `psi.memory.full.avg10` and `psi.memory.some.avg10`
   - swap used, and its trend
   - `team_up_rss_kb / (MemTotal - MemAvailable)` at the last sample (team-up's
     share of used memory)
   - worker count at the last sample and its maximum in the window
   - the gap between the last sample's time and the end of the previous
     boot, if known. A large gap means the sampler itself had stopped,
     which is evidence of a stall.

**Verdict** (`team_up_suspected | other_cause | clean_shutdown | unknown`):

- `clean_shutdown`: an orderly shutdown was found.
- `team_up_suspected`: not clean, and memory exhaustion is evident (an OOM
  record, or `MemAvailable < 5%`, or `psi.memory.full.avg10 > 20`), and
  team-up's share of used memory was at least 50% in the last sample.
- `other_cause`: not clean, memory exhaustion is evident, but team-up's
  share was below 50%.
- `unknown`: anything else, including no telemetry from the previous boot.

The thresholds live in config (`telemetry.verdict`) with these defaults;
the report records which thresholds it applied.

Output: `~/.team-up/logs/restart-<boot_id>.json`

```json
{
  "schema": "team-up.restart-report/v1",
  "boot_id": "…", "previous_boot_id": "…",
  "verdict": "team_up_suspected",
  "shutdown": { "kind": "unclean", "source": "journal" },
  "oom": [{ "at": "…", "process": "claude", "pid": 1234, "team_up_run": "2026…-ab12" }],
  "window": { "from": "…", "to": "…", "samples": 20,
    "min_mem_available_ratio": 0.03, "max_psi_memory_full_avg10": 41.2,
    "team_up_share_last": 0.78, "workers_last": 6, "workers_max": 6 },
  "thresholds": { "mem_available_ratio": 0.05, "psi_full_avg10": 20, "team_up_share": 0.5 },
  "evidence_gaps": ["kernel journal not readable: not in systemd-journal group"]
}
```

`team-up doctor` gets one finding: a `team_up_suspected` report newer than
7 days is `high`, so the human sees it without opening a file.

### Worker footprint statistics

`team-up telemetry stats [--days 7] [--json]` computes p50/p95/max RSS per
worker (and per `role`/`cli`, since a Codex worker and a Claude worker
differ), over all samples. Plan 3 reads the same numbers through
`workerFootprint({ days })`.

## Files

- new `src/telemetry/sample.mjs`, `src/telemetry/store.mjs` (append, fsync,
  retention, read window by boot_id), `src/telemetry/restart.mjs`,
  `src/telemetry/timer.mjs` (unit rendering and install, modeled on
  `gc-timer.mjs`), `src/telemetry/cli.mjs`
- `src/cli.mjs`: `team-up telemetry <sample|install-timer|restart-report|stats>`
- `src/paths.mjs`: `telemetryDir(env)` honoring `TEAM_UP_HOME`
- `src/sandbox/systemd.mjs`: `--unit=team-up-<runId>`, recorded in
  `state.sandbox.unit`
- `src/runs/runs.mjs` `cmdResume`: run `analyzeRestart` first and print the
  verdict
- `src/doctor.mjs`: restart-report finding
- docs: README section and `docs/configuration.md` keys

## Tests

- `takeSample` against a planted `/proc` tree: meminfo, loadavg, pressure
  files present and absent, a worker tree with two children
- cgroup path: planted `memory.current` for a systemd-run worker
- store: fsync path exercised, retention deletes only old files, a corrupt
  line is skipped rather than failing the read
- `analyzeRestart`: same boot (null), clean shutdown, OOM with team-up
  victim, OOM with other victim, memory exhaustion without OOM record, no
  previous telemetry, unreadable journal → `unknown` plus `evidence_gaps`
- verdict thresholds from config override the defaults
- timer units render with absolute paths and quote safely (copy the
  `gc-timer` tests)

## Acceptance criteria

- With the timer installed, `~/.team-up/telemetry/` grows by one line every
  ~30 s and each line names every live worker with a non-zero RSS.
- `kill -9` of the sampler or a forced reboot loses at most the sample in
  flight.
- After a reboot, `team-up runs resume` prints the verdict, and the report
  file names its evidence and its gaps.
- No new dependency; no root.

## Open questions

- Is the kernel journal readable for the user on the target server? If
  not, add the user to `systemd-journal` or accept `unknown` more often.
  Answered on the target server: readable, but `journalctl -k -b -1` had no
  entries — journald kept logs in memory only. The report now names a
  volatile journal (`journalPersistence`) as a gap with the fix, an empty
  kernel grep over an unlogged boot no longer counts as "no OOM", and
  `doctor` reports `journal_not_persistent` (medium) once telemetry runs.
- Is 30 s right? Memory blow-ups by parallel Codeys can take less than that.
  10 s triples the cost and is still small; decide after a week of data.
