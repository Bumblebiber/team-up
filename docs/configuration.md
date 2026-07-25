<!-- o9k-provenance
who: cursor:grok-4.5
when: 2026-07-25T13:44:12.175Z
why: Document null reasoning map and CLI sandbox capabilities
trigger: second review pushback + findings 7-8
host: cursor
-->
<!-- o9k-provenance
who: cursor-agent:grok
when: 2026-07-25T13:19:51.465Z
why: team-up configuration migration docs
trigger: plan Task 10
host: cursor
-->
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

## Model profiles

Specialists declare abstract `{ tier, reasoning }`. Resolution keeps **exact
tier only** — never upgrades or downgrades. Legacy roster `tier: "mid"` imports
as `medium`.

## Accounts and reasoning maps

Specialist-eligible models (any model with a `tier`) must declare:

- `account` — key into top-level `accounts` (`subscription` or `credit`)
- `reasoning` — map of abstract levels (`max|high|medium|low`) to CLI-native effort values

An **explicit** map entry whose value is `null` means: this CLI/model supports
that abstract reasoning level as its default and needs **no** effort argument
(the `{effort}` template slot is dropped). A **missing** key means that level
is unsupported for the model (profile resolution skips it).

Legacy `tier: "mid"` imports as `medium` via `migrateRoster()`. After copying
an old `~/.o9k/roster.json`, run migration (or `team-up init` refresh) before
resolving Hannes (`frontier:max`) / Hugo (`medium:low`).

## CLI sandbox capabilities

Per-CLI optional fields (top-level or under `sandbox`):

| Field | Meaning |
|-------|---------|
| `mediated_commands` | CLI can enforce command/tool allowlists via a broker |
| `token_budget_adapter` | CLI can enforce hard `budget.max_tokens` |
| `sandbox_runtime_paths` / `sandbox.runtime_paths` | Extra read-only binds for home-installed CLIs under `ProtectHome=tmpfs` |

Home-installed CLIs must list runtime/auth paths explicitly. Missing or
invalid paths fail spawn with `SANDBOX_RUNTIME_UNAVAILABLE`.
