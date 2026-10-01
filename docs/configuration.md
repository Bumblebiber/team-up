# Configuration

## Paths

| Concern | Env | Default write | Legacy read fallback |
|---------|-----|---------------|----------------------|
| Home | `TEAM_UP_HOME` | `~/.team-up` | — |
| Roster | `TEAM_UP_ROSTER` / `O9K_ROSTER` | `~/.team-up/roster.json` | `~/.o9k/roster.json` |
| Usage | `TEAM_UP_USAGE` / `O9K_USAGE` | `~/.team-up/usage.json` | `~/.o9k/usage.json` |
| Runs | `TEAM_UP_RUNS` / `O9K_RUNS` | `~/.team-up/runs` | — |
| Scores | `TEAM_UP_SCORES` / `O9K_SCORES` | `~/.team-up/scores.json` | `~/.o9k/roster-scores.json` |

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

Session handoff work orders live in `~/.team-up/handoffs/` (open) and
`~/.team-up/handoffs/done/` (closed). They are not written into project repos.
