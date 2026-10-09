# team-up

Standalone deterministic model roster and specialist runtime.

`team-up` owns roster policy, usage gates, mailbox runs, role/chain
resolution, specialist packages, project policy trust, context materialization, and
worker launch. o9k keeps a thin compatibility adapter only.

## Install

team-up is not published to npm: the `team-up` package there is an unrelated
project. Install from a clone:

```bash
git clone https://github.com/Bumblebiber/team-up.git && cd team-up
npm ci              # without it every command fails with ERR_MODULE_NOT_FOUND
npm link            # puts `team-up` on PATH, linked to this checkout
team-up init        # copies roster.example.json to ~/.team-up/roster.json
team-up validate && team-up pick --role implementer
```

Then curate `~/.team-up/roster.json` down to the CLIs you have and are logged
in to; `team-up doctor` reports what does not add up.

The example's Claude command carries `--dangerously-skip-permissions`, and
Claude Code asks once per machine user to accept that mode ("Bypass Permissions
mode … Yes, I accept"). A dispatched worker would sit on that screen in its
detached tmux pane, so accept it before the first dispatch: run
`claude --dangerously-skip-permissions` once in a terminal and choose
"Yes, I accept", or set `"skipDangerousModePermissionPrompt": true` in
`~/.claude/settings.json` (that is what accepting writes). Specialist launches
strip the flag and never show the screen.

Requirements:

- Linux. State locking uses `/usr/bin/flock` (util-linux), resource checks read `/proc`.
- Node.js 18 or newer for the CLI; `npm test` needs Node 21 or newer.
- tmux and bash: every dispatched worker runs in a detached tmux session.
- The worker CLIs your roster names (claude, codex, cursor-agent, opencode, hermes), logged in.
- `expect`, for the usage collectors that read each CLI's usage screen.
- Optional: inotify-tools, so `runs wait` wakes on mailbox writes instead of polling every second.
- Optional: systemd `--user` plus `loginctl enable-linger $USER`, for the gc, resume-at-boot and telemetry timers.

Claude Code plugin (the skills and the SessionStart hook):

```bash
claude plugin marketplace add /path/to/team-up
claude plugin install team-up@team-up
```

The plugin is installed as a copy pinned to its version. After pulling a new
version run `claude plugin update team-up@team-up` at every scope it is
installed in, then restart the session.

## Quick start

```bash
node bin/team-up.mjs version   # 0.7.0
node bin/team-up.mjs validate
node bin/team-up.mjs pick --role <role>
node bin/team-up.mjs specialist inspect ../team-up-with-tessa
node bin/team-up.mjs specialist install ../team-up-with-tessa   # selects this installed version
# for specialists that run commands, review and trust the project's policy
node bin/team-up.mjs specialist trust-policy --project /abs/path
node bin/team-up.mjs runs create ...
node bin/team-up.mjs runs wait <run-id>
```

State lives under `~/.team-up` (override with `TEAM_UP_HOME`). The legacy
`O9K_*` environment aliases still work; files under `~/.o9k` are not read
automatically. Copy needed state into `~/.team-up` during migration.

## Capability isolation

`team-up` keeps shared skills, plugins, MCPs, frameworks, and bundles inert in
a content-addressed pool. Installation does not activate a package. The human
enables an exact checksum for `all` or named specialists; an explicit
exclusion wins over `all`.

Use the supervisor-only `/team-up-manage` skill or deterministic
`team-up capability` commands. Specialist recommendations are opt-in and
start unselected.

Skills come in three layers — main-only, shared, specialist-only — declared
with `team-up-scope` in a skill's frontmatter. `--for host` links a pool
package into the host's skill directory, so a shared skill is one copy for
host and specialists alike. A package can ask the launcher to open every
worker prompt with one of its skills (`style.caveman` does: `/caveman`). See
[specialists.md](docs/specialists.md#three-skill-layers).

Results nobody has read yet: `team-up runs uncollected`; the host's `intake`
skill reads, checks and records them, then `team-up runs collect <id>`.

This isolates model context, not Unix files. Workers run as the same trusted
user. A harness must have a version-keyed verification record that explicitly
stores `context_isolation: "team-up.context-isolation/v1"` before it is
eligible for specialist work. Live `team-up harness verify` plants global
canaries on a fake HOME, prepares a capsule launch, and collects a live CLI
observation proving the full selected skill/plugin/MCP/framework matrix with
fresh content nonces (Claude stream-json init + tool proof). The token is
stored only on an exact match with every forbidden canary absent. Missing,
malformed, or skipped live observations stay fail-closed at
`context_isolation: null`. Codex 0.145.0 declares `context_isolation: null`
because it lacks native plugin/framework isolation surfaces for the full
generic matrix — partial MCP/skill proof must not grant v1. Closed-world
content manifests require Linux `/proc` fd-based directory walks; other
platforms fail closed rather than using a weaker path-based fallback.

## Resource telemetry and restart reports

```bash
node bin/team-up.mjs telemetry install-timer   # sample every 30 s (systemd user timer)
loginctl enable-linger $USER                   # keep user timers running after logout
node bin/team-up.mjs telemetry stats           # p50/p95 RSS per worker, per cli and role
node bin/team-up.mjs telemetry restart-report  # was the last restart team-up's doing?
```

Each sample (`~/.team-up/telemetry/YYYY-MM-DD.jsonl`, fsynced, 7 days) holds
memory, pressure (PSI), load and every live worker's RSS. After a reboot,
`team-up runs resume` first writes `~/.team-up/logs/restart-<boot_id>.json`
with a verdict — `team_up_suspected`, `other_cause`, `clean_shutdown` or
`unknown` — plus the evidence and what could not be checked. The kernel log
needs membership in `systemd-journal` (or `adm`); without it the verdict leans
on the samples and says so. It also has to survive the reboot: with
journald's default `Storage=auto` that needs `/var/log/journal` to exist
(`sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald`);
`doctor` flags a volatile journal once telemetry runs. A `team_up_suspected`
report from the last 7 days is a high `doctor` finding.

## Parent session recovery

```bash
node bin/team-up.mjs runs resume-install   # run `runs resume --boot` at every boot
loginctl enable-linger $USER               # so it runs without a login
```

Every run records the session that dispatched it (`STATE.json` →
`parent`, with `detected_by`). For Claude Code the plugin's `SessionStart`
hook writes `~/.team-up/sessions/<pid>.json`; Hermes, Codex and OpenCode are
read from their session env vars. After a restart, `runs resume` restarts the
workers, then wakes each parent **once**: a parent whose tmux is gone is
resumed there with a message naming its runs and the `runs wait` command for
each watcher; a Claude parent outside tmux gets the message at its next
session start. A live parent is not disturbed. Per-CLI details:
[harness-session-identity.md](docs/harness-session-identity.md).

## Staggered resume and admission

```bash
node bin/team-up.mjs admission check --cli codex   # would one more worker fit now?
node bin/team-up.mjs admission queue               # where a boot resume is
node bin/team-up.mjs admission reset               # lift the cap a restart left
```

`runs resume` no longer starts everything at once. Parents come first, then
runs waiting on a human, then the oldest runs; each next start waits for the
previous worker's `HEARTBEAT` (at most 120 s) and a fresh admission check
(free memory after the worker's p95 and a reserve, memory pressure, swap
trend, worker limit). After a `team_up_suspected` restart only half of the
workers that ran before come back; the rest wait in `waiting_capacity`
(`reason: "resources"`), the parent's message says which, and the GC timer
starts them one per pass once there is room. `team-up dispatch` and
`specialist run` go through the same check and fail with `ADMISSION_REFUSED`
(exit 3); `--force-admission` overrides it, `specialist run --wait-capacity`
parks the run instead. Re-run `runs gc-install` and `runs resume-install`
once after updating so the units pick up the new settings. Keys:
[configuration.md](docs/configuration.md#admission).

## Docs

- [configuration.md](docs/configuration.md)
- [specialists.md](docs/specialists.md)
- [command-broker.md](docs/command-broker.md)
- [harness-session-identity.md](docs/harness-session-identity.md)
- Runtime supervision design: `docs/specs/2026-07-25-runtime-supervision-design.md`

## Tests

```bash
npm test
bash test/runs/wait-mailbox.test.sh
```

## License

MIT
