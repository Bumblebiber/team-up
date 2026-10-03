# Configuration

## Paths

| Concern | Env | Default write | Legacy read fallback |
|---------|-----|---------------|----------------------|
| Home | `TEAM_UP_HOME` | `~/.team-up` | — |
| Roster | `TEAM_UP_ROSTER` / `O9K_ROSTER` | `~/.team-up/roster.json` | `~/.o9k/roster.json` |
| Usage | `TEAM_UP_USAGE` / `O9K_USAGE` | `~/.team-up/usage.json` | `~/.o9k/usage.json` |
| Runs | `TEAM_UP_RUNS` / `O9K_RUNS` | `~/.team-up/runs` | — |
| Scores | `TEAM_UP_SCORES` / `O9K_SCORES` | `~/.team-up/scores.json` | `~/.o9k/roster-scores.json` |
| Telemetry | `TEAM_UP_TELEMETRY` | `~/.team-up/telemetry` | — |

Writes always target `~/.team-up` (or an explicit `TEAM_UP_*` override).

## Migration from o9k

```bash
mkdir -p ~/.team-up
cp ~/.o9k/roster.json ~/.team-up/roster.json
cp ~/.o9k/usage.json ~/.team-up/usage.json   # if present
```

Point o9k adapters at this engine:

```bash
export TEAM_UP_BIN=/path/to/team-up/bin/team-up.mjs
# or: export TEAM_UP_ROOT=/path/to/team-up
```

## Specialists

Each specialist runs on a role's chain or on a chain of its own, set under
`specialists` (or in the dashboard's Specialists widget):

```json
"specialists": {
  "coding.codey": { "role": "implementer" },
  "review.revan": { "chain": ["claude:claude-opus", { "model": "gpt-6-sol", "cli": "codex", "effort": "xhigh" }] }
}
```

Exactly one of `role` or `chain`. The chain is tried top to bottom with the same
gates as role dispatch, plus the harness capabilities the specialist needs
(context isolation, command broker). Effort comes from the chain entry, then the
role's `effort`, then the model's default. An unassigned specialist does not
launch. A manifest's `model_profile` is ignored; `migrateRoster()` drops legacy
`tier` fields, specialist tier profiles and the old `triage` block (its
`key_file` moves to `openrouter.key_file`).

## Accounts

A model's `account` keys into top-level `accounts` (`subscription` or
`credit`). A declared account that is disabled or out of credit bars the model;
a model without one is not gated by account.

## CLI sandbox capabilities

Per-CLI optional fields under `sandbox` (or top-level legacy aliases):

| Field | Meaning |
|-------|---------|
| `runtime_paths` / `sandbox_runtime_paths` | Non-empty list of extra read-only binds for home-installed CLIs under `ProtectHome=tmpfs` when OS isolation is applied. Empty `[]` = not configured. |

Command-broker support comes from installed harness adapters plus
`~/.team-up/harness-verification` records — **never** from roster booleans
like `mediated_commands`. Token targets are advisory (see
`docs/specialists.md`); there is no hard `token_adapter` gate.

Specialists that declare `permissions.commands` resolve only CLI cells whose
verified harness advertises `team-up.command-broker/v1`. Otherwise the
profile fails with `PROFILE_UNAVAILABLE` before a run is created.

Trusted specialist launches use **best-effort** OS isolation. Missing home
CLI runtime paths still fail with `SANDBOX_RUNTIME_UNAVAILABLE` when
isolation is applied. See `docs/command-broker.md`.

## Limits

| Field | Default | Meaning |
|-------|---------|---------|
| `limits.warn_at` | `0.9` | Usage fraction that triggers a prepare-for-handoff warning |
| `limits.handoff_at` | `0.95` | Usage fraction that triggers mandatory handoff |
| `limits.handoff_at_burst` | `0.8` | Burst-window handoff threshold (5h/session windows) |
| `limits.handoff_retention_days` | `14` | Open and closed handoff files under `~/.team-up/handoffs/` older than this are deleted by `team-up runs gc` |

The warning and handoff thresholds (the limit-watch hook and `team-up usage
--check`) count only the windows of the CLI the calling session runs on; an
exhausted codex window never ends a Claude Code session. When the host CLI
cannot be detected, every window counts.

Session handoff work orders live in `~/.team-up/handoffs/` (open) and
`~/.team-up/handoffs/done/` (closed). They are not written into project repos.

## Telemetry

The `telemetry` block of `roster.json`. Every key is optional; a value of the
wrong type is an error rather than a silent default.

| Field | Default | Meaning |
|-------|---------|---------|
| `telemetry.retention_days` | `7` | Day files under `~/.team-up/telemetry/` older than this are deleted by the sampler |
| `telemetry.verdict.mem_available_ratio` | `0.05` | `MemAvailable / MemTotal` below this in the last 10 minutes counts as memory exhaustion |
| `telemetry.verdict.psi_full_avg10` | `20` | `full avg10` memory pressure above this counts as memory exhaustion |
| `telemetry.verdict.team_up_share` | `0.5` | team-up's share of used memory at the tightest sample at or above this makes an unclean, memory-exhausted restart `team_up_suspected` |

An OOM kill whose victim was a team-up worker makes the verdict
`team_up_suspected` regardless of the share. A kill inside a memory ceiling
(`CONSTRAINT_MEMCG`) is recorded but is not memory exhaustion.

## Admission

The `admission` block of `roster.json` decides whether one more worker may
start (`team-up dispatch`, `team-up specialist run`, `runs resume`, and parked
runs started by `runs gc`). Every key is optional; a wrong value is an error.

| Field | Default | Meaning |
|-------|---------|---------|
| `admission.max_workers` | `null` | Fixed worker limit. `null` derives it: `floor((MemTotal × 0.7 − idle used memory) / p95 worker RSS)` from telemetry |
| `admission.fallback_max_workers` | `2` | The limit while telemetry has fewer than `min_samples` worker samples or no idle baseline |
| `admission.min_samples` | `20` | Worker samples needed before a per-cli (else overall) p95 is trusted |
| `admission.reserve_mb` | `1024` | `MemAvailable` that must be left after the new worker's p95 |
| `admission.psi_some_max` | `10` | Refuse while memory pressure `some avg10` is at or above this |
| `admission.psi_full_max` | `2` | Refuse while memory pressure `full avg10` is at or above this |
| `admission.memory_ceiling.enabled` | `false` | Give each sandboxed worker `MemoryHigh`/`MemoryMax` |
| `admission.memory_ceiling.high_factor` | `1.5` | `MemoryHigh` = p95 × this |
| `admission.memory_ceiling.max_factor` | `2` | `MemoryMax` = p95 × this; the kernel kills that worker alone above it |

Without `max_workers` and without enough telemetry (no `team-up telemetry
install-timer`, or fewer than `min_samples` worker samples), every start is
capped at `fallback_max_workers`. `doctor` reports that as
`admission_fallback_limit`, and a refusal it causes names both ways out: run
the telemetry timer, or set `max_workers`.

A start is also refused while swap use grew across the last three samples.
After a `team_up_suspected` restart, `runs resume` caps the limit at half the
workers that ran before it; the cap holds until `team-up admission reset` or
24 h without a refusal. `team-up admission check [--cli <cli>]` shows the
decision and why (exit 3 when refused).

Memory ceilings only hold under `systemd-run --user` with the memory
controller delegated to the user manager; `doctor` reports both.
