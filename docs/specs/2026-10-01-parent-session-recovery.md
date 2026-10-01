# Parent Session Recovery

## Status

Plan 2 of 3, agreed in conversation 2026-10-01. **Implemented 2026-10-01**
(phases 0–3; deviations below). Phase 0's findings are in
`docs/harness-session-identity.md`. Plan 1 (`2026-10-01-resource-telemetry-and-restart-report.md`)
counts parent sessions in telemetry once this plan records them. Plan 3
(`2026-10-01-staggered-resume-and-admission.md`) decides *when* each
session restarts; this plan decides *what* gets restarted and what it is
told.

## Problem

After a crash or reboot, a worker can be restarted (`runs resume`), but the
session that dispatched it — the parent, the human's orchestrating agent —
is lost. Its in-host watcher subagent died with it, so even a recovered
worker reports to nobody.

The pieces are mostly there and unused:

- `STATE.json` already has `parent: { cli, sessionId, tmux, attach }`
  (`createRun`, `src/runs/runs.mjs`).
- `buildResumePlan` already emits `spawn_parent` (`claude --resume <id>`
  in tmux) with an inject message, and `flag_reattach_watcher`.

What breaks it in practice:

1. **The parent is never recorded.** The two paths that actually launch
   workers hard-code it: `src/specialists/launcher.mjs` writes
   `parent: { cli: "team-up", attach: "manual" }`; `src/roster/roster.mjs`
   and `src/roster/command.mjs` write `{ cli: "manual", attach: "manual" }`.
   Only a hand-typed `runs create --parent-*` fills it.
2. **The inject message is generic** (`INJECT.parent`: "Continue
   orchestration…"). It names neither the worker tmux session nor the
   command for re-attaching a watcher.
3. **Resume is per run.** A parent with three runs in flight is spawned
   three times, as three tmux sessions on one session id.
4. **`REATTACH_WATCHER` is written and never read** — one line in
   `skills/roster/SKILL.md` mentions it.
5. **Nothing runs resume at boot.** `skills/roster/SKILL.md`: "no unit
   ships for this — run it yourself".

## Goals

- Every run records which session dispatched it, automatically, for every
  CLI that exposes enough to do so.
- After a restart, each parent session is restarted once and told exactly
  what it had in flight and what to do: which watcher to re-spawn, on which
  run, with which worker tmux session.
- Resume runs on its own at boot.

## Non-goals

- Resuming a parent the human runs outside tmux (a plain terminal, an IDE
  panel). Those stay `attach: "manual"`; the human gets the message on next
  start instead (see "Manual parents").
- Ordering and throttling of restarts: plan 3.

## Phase 0 — research: session identity and hooks per CLI

Claude Code is understood: hooks receive `session_id` on stdin, a
`SessionStart` hook exists, `claude --resume <id>` restores a session.
For the others, nothing in this repo establishes what is possible. Before
any non-Claude code is written, research and record, per CLI:

| Question | Why it matters |
|---|---|
| Is there a hook/plugin/extension point that runs at session start? Which events exist (start, stop, pre/post tool, compaction)? | Where to record the session from |
| What does a hook receive: session id, cwd, transcript path, pid? In what form (stdin JSON, env, args)? | The identity to store |
| Is the session id visible to a child process (env var in the shell tool)? | Lets `team-up` read it directly, no hook needed |
| How is a session resumed by id from the command line, non-interactively started in tmux? | What `spawn_parent` runs |
| Can a message be injected into a resumed session (initial prompt arg, or a TUI that accepts pasted input)? | How the wake-up message arrives |
| Where are sessions stored on disk, and is the format stable? | Fallback discovery, and staleness checks |
| Does a resumed session keep its subagents/background tasks? (Almost certainly not; confirm.) | Whether the watcher must be re-spawned |
| Version the answer applies to | The repo pins behaviour per CLI version elsewhere (`harness verify`) |

CLIs: **Cursor** (`cursor-agent`), **Codex**, **OpenCode**, **Gemini
CLI**, **Hermes**. Also re-confirm Claude Code against the installed
version (`SessionStart` input fields, `--resume` behaviour with a
positional prompt).

Deliverable: `docs/harness-session-identity.md`, one section per CLI, every
claim with a source (doc URL, source file and line, or a measured
transcript with the CLI version), and a per-CLI verdict: `hook`, `env`,
`disk-scan`, or `unsupported`. Unknowns are written down as unknown, not
guessed. This is a good first job for `research.reanna` (network, read-only)
with the host checking the measured parts.

Phase 1 implements Claude Code. Each further CLI is its own small PR after
phase 0, against the verdict there. A CLI rated `unsupported` keeps
`attach: "manual"`.

## Phase 1 — record the parent (Claude Code first)

### Session registry

A `SessionStart` hook shipped by the team-up plugin
(`hooks/hooks.json` + `hooks/session-start.mjs`). It reads the hook input
from stdin and writes `~/.team-up/sessions/<claude_pid>.json`:

```json
{
  "schema": "team-up.session/v1",
  "cli": "claude",
  "session_id": "…",
  "cwd": "/home/…/project",
  "pid": 12345,
  "tmux": { "session": "main", "pane": "%3" },
  "started_at": "…",
  "boot_id": "…"
}
```

- `pid` is the hook process's parent (the CLI). Confirm in phase 0 that
  hooks are direct children; if they run through a shell, walk up to the
  first `claude` process.
- `tmux` from `$TMUX`/`$TMUX_PANE` plus `tmux display-message -p -t
  $TMUX_PANE '#S'`; `null` when not in tmux.
- `SessionStart` also fires on `--resume` and after `/clear`/compaction
  with a `source` field; on resume the id is unchanged, on `/clear` it
  changes. Overwrite the file each time.
- Stale entries (pid dead, or `boot_id` differs) are pruned by `runs gc`.

The hook must never block or fail the session: a 1 s budget, all errors
swallowed and logged to `~/.team-up/logs/hooks.log`.

### Resolving the parent at dispatch

`src/runs/parent.mjs` exports `detectParent({ env, procRoot })`:

1. Walk the ppid chain from `process.pid` (`/proc/<pid>/stat`) up to 16
   levels, and use the first pid that has a registry file whose `boot_id`
   matches the current boot.
2. Else, if phase 0 found an env var carrying the session id for the CLI
   that is running, use it.
3. Else return `{ cli: <best guess from process name> | "manual", attach:
   "manual" }`. Never invent a session id.

`attach` is `"tmux"` when the registry has a tmux session, else
`"manual"`.

Wire it into the three call sites that hard-code the parent today:
`launcher.mjs` (`createRunFn({ parent })`), `roster.mjs`, `command.mjs`.
An explicit `--parent-*` on `runs create` still wins.

Record `parent.detected_by: "registry" | "env" | "flag" | "none"` so a
wrong parent can be traced.

## Phase 2 — one wake-up per parent

### Grouped resume plan

Split `buildResumePlan` into per-run worker actions (unchanged) and a
second pass, `buildParentPlan(states)`, that groups active runs by parent
key (`cli + sessionId`, falling back to `tmux`):

- one `spawn_parent` per group whose tmux session is gone
- if the parent tmux session is still alive (only the watcher died, or
  only the worker crashed): no spawn, but the same message is pasted into
  the live session — the watcher is gone either way
- `attach: "manual"` groups: no spawn; the message goes to
  `~/.team-up/sessions/pending/<sessionId>.md` (see "Manual parents")

### The message

Built by `renderParentWakeup(group, { restartReport })` from the runs'
state *after* the worker actions ran, so it reflects what was actually
restarted:

```
Your session resumed after a system restart (verdict: team_up_suspected —
see ~/.team-up/logs/restart-<boot>.json).

You had 3 team-up runs in flight. Your watcher subagents did not survive.
For each run below, re-spawn ONE cheap watcher subagent whose only job is
the command shown (see skill `dispatch`, Path B):

- run 20261001T0912-ab12  coding.codey  worker tmux: team-up-ab12 (restarted)
    team-up runs wait 20261001T0912-ab12 --ceiling-sec 7200
- run 20261001T0915-cd34  testing.tessa  worker tmux: team-up-cd34 (still running)
    team-up runs wait 20261001T0915-cd34 --ceiling-sec 7200
- run 20261001T0920-ef56  review.revan  deferred until resources allow (plan 3)
    no watcher yet; `team-up runs list --deferred` shows when it starts

1 result finished before the crash and has not been read:
    team-up runs uncollected   → then use skill `intake`

Do not re-dispatch any of these runs.
```

Rules: list every run, its specialist/role, the worker tmux name, and its
state after resume; give the exact watcher command; point to `intake` when
`runs uncollected` is non-empty; say "do not re-dispatch". Keep it under
~40 lines; beyond 10 runs, list them in a file and give its path.

Delivery uses the existing `pasteInject` after `waitTmuxReady`. Phase 0
decides whether, for Claude Code, the message goes as the positional prompt
of `claude --resume <id> "<message>"` instead. That avoids a paste race and
is preferred if it works.

### `REATTACH_WATCHER`

Keep writing it; it becomes the marker the message refers to, and
`runs wait` deletes it when a watcher attaches. A marker still present 10
minutes after the wake-up goes into `runs stale` as "nobody re-attached".

### Manual parents

A parent that is not in tmux cannot be restarted by team-up. Its message is
written to `~/.team-up/sessions/pending/<sessionId>.md`. The same
`SessionStart` hook checks that directory: when a session starts, or
resumes with that id, the hook prints the pending message as additional
context (`hookSpecificOutput.additionalContext`; confirm the field in phase
0) and moves the file to `delivered/`. So the human's next session start in
that project gets the message even without tmux.

## Phase 3 — resume at boot

`team-up runs resume-install`, modeled on `installGcTimer`:

- `team-up-resume.service`: `Type=oneshot`, `ExecStartPre=/bin/sleep 20`
  (let the network and the user manager settle), `ExecStart=… runs resume`,
  `WantedBy=default.target`
- documented requirement: `loginctl enable-linger $USER`, or the unit only
  runs once the user logs in
- it runs the restart report first (plan 1), then the plan 3 scheduler,
  then this plan's parent wake-ups

`skills/roster/SKILL.md` and `skills/dispatch/SKILL.md` drop "no unit
ships for this".

## Files

- new `hooks/hooks.json`, `hooks/session-start.mjs` (plugin root; bump the
  plugin version so hosts pick it up)
- new `src/runs/parent.mjs` (`detectParent`, registry read/prune)
- new `src/runs/wakeup.mjs` (`buildParentPlan`, `renderParentWakeup`)
- `src/runs/runs.mjs`: split plan, grouped execution, `INJECT.parent`
  replaced, `resume-install` command
- `src/specialists/launcher.mjs`, `src/roster/roster.mjs`,
  `src/roster/command.mjs`: use `detectParent`
- `src/runs/gc.mjs`: prune stale registry entries
- `src/runs/stale.mjs`: unconsumed `REATTACH_WATCHER`
- `docs/harness-session-identity.md` (phase 0)
- skills: `dispatch`, `roster` (resume text), `intake` (mentioned from the
  wake-up)

## Tests

- hook: planted stdin JSON → registry file; never non-zero exit; tmux and
  no-tmux variants; pending message is emitted and moved
- `detectParent`: planted `/proc` ppid chain with a registry hit at depth
  3; stale `boot_id` ignored; no hit → `manual`, no session id
- grouping: three runs, one parent → one `spawn_parent`; two parents → two;
  live parent tmux → inject without spawn; manual → pending file
- message: golden-file test for the example above, including deferred and
  uncollected lines; truncation beyond 10 runs
- resume-install renders units with absolute paths (copy `gc-timer` tests)

## Acceptance criteria

- A specialist launched from a Claude Code session in tmux records that
  session's id and tmux name, with `detected_by: "registry"`.
- After a forced reboot with two runs from one parent: one parent tmux
  session comes back, receives one message naming both runs and their
  watcher commands, and re-attaches watchers without re-dispatching.
- A parent outside tmux gets the same message at its next session start.
- `docs/harness-session-identity.md` exists with a sourced verdict for
  Cursor, Codex, OpenCode, Gemini CLI and Hermes.

## Open questions

- Can `claude --resume <id> "<prompt>"` take the message as a positional
  prompt in interactive mode? (Phase 0.)
- Does a resumed Claude session need the original cwd to find its
  transcript? `spawn_parent` uses `state.cwd`, which is the worker's cwd,
  not the parent's. The registry's `cwd` must be used instead.

## Implementation notes and deviations

- **Env detection beside the hook.** Phase 0 found session-id env vars for
  Claude Code (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`), Hermes, Codex and
  OpenCode 2.x. `detectParent` asks the registry first, then these
  (`SESSION_ENV`), and accepts a variable only when the CLI process that owns
  it is among its own ancestors: a worker whose tmux server inherited a
  parent's environment would otherwise claim that parent. Codex tools run
  under a shared daemon, so a Codex parent never takes `$TMUX_PANE` (it is
  `attach: "manual"`) and its cwd is the tool's working directory.
- **Hook pid.** The hook uses `$CLAUDE_PID` and walks up past `sh -c` only
  without it. Registry records carry `pid_start` (start time in ticks), so a
  reused pid does not resurrect an old session.
- **Cursor runs Claude hooks** (third-party hooks, on by default). The hook
  records such a chat as `cli: "cursor"` when the Cursor process is found by
  name, and otherwise skips it; it never records a Cursor chat as Claude.
- **Live parent: not pasted into.** The spec pasted the message into a live
  parent tmux. A live session may be mid-turn or mid-typing, and its watcher
  may still be running; it is left alone (`delivery: "alive"`) and the message
  is printed by `runs resume`. `REATTACH_WATCHER` + `runs stale` cover a
  watcher that really is gone.
- **Delivery by command line for every CLI.** Claude `--resume <id> "<msg>"`,
  Codex `resume <id> -C <cwd> "<msg>"`, Hermes `chat --resume <id> -q
  "<msg>"`, Cursor `--resume <id> "<msg>"`. No paste race. OpenCode is not
  resumed automatically (1.x ignores `--prompt` with `-s`; 2.x continues
  interrupted turns itself) and Gemini has no detection yet: both get
  `delivery: "none"`, and the message is printed.
- **Pending messages** are delivered only to Claude Code (the only hook that
  can add context); `additionalContext` reaches the model with the human's
  next prompt.
- **Boot guard.** Until plan 3 staggers resumes, `runs resume --boot` (what
  the unit runs) does nothing when the restart report says
  `team_up_suspected`, so a restart caused by load does not rebuild it.
- **Unit details.** `RemainAfterExit=yes` keeps the tmux server the unit may
  start alive (a finished oneshot's cgroup is killed otherwise); the
  installer's `PATH` (and `TEAM_UP_HOME`) are written into the unit; the unit
  is enabled, not started.
- **Telemetry.** Samples now carry `parents[]` (each live registry session's
  process tree), outside `team_up_rss_kb`.
- **Not measured live:** see the open items in
  `docs/harness-session-identity.md`. Gemini (extension hook) and OpenCode
  resume remain follow-ups.
