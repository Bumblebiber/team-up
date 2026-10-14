# Configuration

## Paths

| Concern | Environment variables | Default path |
|---------|-----------------------|--------------|
| Home | `TEAM_UP_HOME` | `~/.team-up` |
| Roster | `TEAM_UP_ROSTER` / `O9K_ROSTER` | `~/.team-up/roster.json` |
| Usage | `TEAM_UP_USAGE` / `O9K_USAGE` | `~/.team-up/usage.json` |
| Runs | `TEAM_UP_RUNS` / `O9K_RUNS` | `~/.team-up/runs` |
| Telemetry | `TEAM_UP_TELEMETRY` | `~/.team-up/telemetry` |
| Dashboard AI Trending reports (read only) | `TEAM_UP_TRENDING_DIR` | `~/.hermes/cron-outputs/framework-scout` |
| Cron reports (usage-collector, usage-spender) | `TEAM_UP_REPORT_DIR` / `O9K_REPORT_DIR` | `~/.team-up/reports` |

`O9K_*` values are environment aliases only. Files under `~/.o9k` are never
read automatically. Writes target `~/.team-up` (or an explicit
`TEAM_UP_*` override).

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
role's `effort`, then the model's default. `"fast": true` on a chain entry
(role or specialist) runs it in fast mode: codex adds the `priority` service
tier, cursor uses the model's `-fast` id when a scan listed one (else it runs
without fast and says so). Fast answers cost more quota. Claude Code's fast mode
draws on paid usage credits only, so team-up does not offer it; other CLIs have
none. A `--model` pin does not inherit fast. An unassigned specialist does not
launch. A manifest's `model_profile` is ignored. When migrating an older roster,
remove legacy `tier` fields and the old `triage` block; move its `key_file` to
`openrouter.key_file` if needed.

## Accounts

A model's `account` keys into top-level `accounts` (`subscription` or
`credit`). A declared account that is disabled or out of credit bars the model;
a model without one is not gated by account.

A subscription account may name its `plan` (`claude`: pro|max5x|max20x,
`codex`: plus|pro|business|enterprise, `cursor`: hobby|pro|pro_plus|ultra|teams,
`gemini`: free|plus|pro|ultra). No gate reads it; `scripts/usage-spender.py`
uses it to size how much spare quota one task is worth.

## Harness support

Specialist capability support comes from the installed harness adapter's
declared capabilities, never from roster booleans such as
`mediated_commands`. `~/.team-up/harness-verification/<cli>/<version>.json`
records are health evidence only: missing, failed, or drifted records appear
as doctor warnings and do not block a launch. Run `team-up harness verify
claude` to refresh the live isolation check. Token targets are advisory (see
`docs/specialists.md`); there is no hard `token_adapter` gate.

Specialists that declare `permissions.commands` resolve only CLI cells whose
installed harness adapter declares `team-up.command-broker/v1`. Otherwise the
profile fails with `PROFILE_UNAVAILABLE` before a run is created.

Specialists with `permissions.commands` need a project `.team-up/commands.json`
whose checksum has been trusted with
`team-up specialist trust-policy --project <absolute-path>`. A missing policy
removes command permissions for that launch; an untrusted policy blocks launch.

## Editing settings

Every setting in this file that a person plausibly changes is editable in the
dashboard's **Settings** page, with its help text, unit, default and when it
takes effect (the registry is `src/dashboard/settings.mjs`). A save is
validated, written to `roster.json` with a backup, and "reset" removes the key
so the default applies again. Deliberately not editable from a browser:
`clis.*.cmd` / `headless_cmd` (arbitrary command execution) and
`openrouter.key_file` (would read any file); the page lists them with the reason.

The usage watcher re-reads `roster.json` every tick, so `subscriptions` and
`usage_watcher.*` changes apply within a minute, without a restart.

## Limits

| Field | Default | Meaning |
|-------|---------|---------|
| `limits.warn_at` | `0.9` | Usage fraction that asks the agent to converge to a clean committed state |
| `limits.handoff_at` | `0.95` | Usage fraction that triggers a TIM handoff note and session stop |
| `limits.handoff_at_burst` | `0.8` | Burst-window threshold (5h/session windows) |
| `limits.project_min` | `30` | Minutes a burst window's burn rate is projected ahead when routing; `0` turns it off |
| `limits.usage_max_age_min` | `10` | A blocking handoff only trusts usage readings this fresh |
| `limits.idle_session_hours` | `2` | `runs gc` closes a worker's tmux session idle this long |

The warning and limit thresholds (the limit-watch hook and `team-up usage
--check`) count only the windows of the CLI the calling session runs on; an
exhausted codex window never ends a Claude Code session. When the host CLI
cannot be detected, every window counts.

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
`team_up_suspected` regardless of the share.

## Admission

The `admission` block of `roster.json` decides whether one more worker may
start (`team-up dispatch`, `team-up specialist run`, `runs resume`, and stored
dispatch deferrals resumed by `runs gc`). Every key is optional; a wrong value is an error.

| Field | Default | Meaning |
|-------|---------|---------|
| `admission.max_workers` | `null` | Fixed worker limit. `null` derives it: `floor((MemTotal × 0.7 − idle used memory) / p95 worker RSS)` from telemetry |
| `admission.fallback_max_workers` | `2` | The limit while telemetry has fewer than `min_samples` worker samples or no idle baseline |
| `admission.min_samples` | `20` | Worker samples needed before a per-cli (else overall) p95 is trusted |
| `admission.reserve_mb` | `1024` | `MemAvailable` that must be left after the new worker's p95 |
| `admission.psi_some_max` | `10` | Refuse while memory pressure `some avg10` is at or above this |
| `admission.psi_full_max` | `2` | Refuse while memory pressure `full avg10` is at or above this |

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

## Usage spender

The `usage_spender` block tunes `scripts/usage-spender.py` (cron, every 10
minutes). Every key is optional; a value of the wrong type is ignored with a
note in the tick JSON and the built-in value is kept.

| Field | Default | Meaning |
|-------|---------|---------|
| `usage_spender.subscriptions` | `["claude","codex","cursor"]` | Whose spare quota may be spent; `[]` switches the spender off |
| `usage_spender.spawn_from` | `23` | Local hour from which new tasks start |
| `usage_spender.spawn_until` | `3` | Local hour from which no new task starts (exclusive; wraps past midnight; equal to `spawn_from` = all day). Running tasks finish |
| `usage_spender.implement` | `true` | `false`: reviews and triage only, no implement runs |
| `usage_spender.implement_model` | `{"claude":"claude:claude-sonnet"}` | Per CLI, the `cli:model` for implement runs; `""` = the implementer role chain |
| `usage_spender.max_run_h` | `4` | A spender run still active after this long is cancelled |
| `usage_spender.task_cost` | `0.3` | Share of a weekly window one task burns on the smallest paid plan |

## Scheduled jobs

`~/.team-up/cron-jobs.ini` holds one section per scheduled LLM job. Built-in
jobs (`golden-task`, `insights`, `usage-spender-host`) only set `model =
<cli>:<model>`; they are scheduled in the crontab or by the Hermes cron daemon.
The dashboard's **Scheduled jobs** page explains each one, shows next and last
run, and switches crontab jobs on and off (prefixing the line with
`#team-up-off# `), moves their schedule, or sets a whitelisted env knob
(`STALE_RUNS_HOURS`, `INSIGHTS_NO_MERGE`).

Your own jobs are sections with `custom = true`:

```ini
[weekly-deps]
custom = true
description = Check outdated dependencies and open one PR
schedule = 0 6 * * 1
model = claude:claude-sonnet
cwd = /home/you/projects/repo
notify = true
enabled = true
```

The prompt lives in `~/.team-up/cron-prompts/<name>.md`. The ini is the source
of truth: the dashboard regenerates the crontab block between
`# >>> team-up managed jobs …` and `# <<< team-up managed jobs <<<` from it,
one line per enabled job running `scripts/cron-job.sh <name>`. Nothing outside
that block is added or removed; every write re-reads the crontab, keeps a
backup in `~/.team-up/backups/crontab/` and verifies the result. Output goes to
`~/.team-up/logs/cron/<name>.log`; `notify = true` also sends it to Telegram.

## Communication (Telegram)

`~/.team-up/communication.json`, edited on the dashboard's **Communication**
page:

- `bots` — Telegram bots, each an env file (`TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`). The first load imports the host's bots: CronBot, plus
  ReminderBot and the Claude telegram plugin's bot, which carry an `owner`
  because another program reads their replies. A bot added in the dashboard is
  checked with `getMe` and stored in `~/.team-up/telegram/<id>.env` (0600).
  Views show `@username` and the token's last four characters only.
  `listen: true` means replies to the bot are acted on.
- `routes` — sender → bot id or `"bell"` (dashboard bell, no push); `default` is
  where every other sender goes. The page lists team-up's built-in jobs that
  send (`notifies` in `BUILTIN_JOBS`), TIM's watchdogs and your own jobs with
  `notify = true`.
- `replies` — `{model, cwd, instructions}` for a reply that starts a new
  session (claude models only).

`scripts/telegram.py` does the work (stdlib Python, no node on cron's PATH):

- `send` — called by `~/.hermes/bin/send-cron-telegram` for every report. The
  sender is `$TEAMUP_NOTIFY_JOB`, else the calling script's file name without
  `.sh`/`.py`. It appends a footer: 📂 cwd · 🤖 CLI · model · 🧵 session, taken
  from `$TEAMUP_NOTIFY_RUN`'s run (`STATE.json` + `mailbox/SESSION_ID`), else
  `$CLAUDE_CODE_SESSION_ID`, else "script, no session". A routed bot that fails
  falls back to the default; if nothing was sent, the shim sends through
  CronBot as before. `ops-run.sh` writes its run id to `$OPS_RUN_ID_FILE`;
  `cron-job.sh`, `insights-cron.sh` and `golden-task-run.sh` pass it on.
- `serve` — `team-up-telegram-replies.service`. Every 3 s, `getUpdates`
  (timeout 0) on each bot with `listen` and no `owner`; only messages from the
  bot's own chat count, and a bot's first poll skips its backlog (switching
  `listen` resets the offset). A reply to a message whose footer names a
  claude session continues it: `claude -p --resume <id>` in that cwd, with the
  model from the footer. A session whose process is still alive is not
  touched, unless it is the idle terminal of a finished team-up run (then that
  tmux is closed first). Everything else starts a new `claude -p` session from
  `replies`. The answer comes back as a reply, footer included, so it can be
  answered again. Work files live in `~/.team-up/telegram/`.

The SessionStart hook writes a team-up worker's claude session id to
`runs/<id>/mailbox/SESSION_ID` (first write wins).
