# Harness session identity

Phase 0 of `docs/specs/2026-10-01-parent-session-recovery.md`: for each CLI
that can be a parent session, how team-up learns the session id, how it
resumes that session in tmux, and how the wake-up message gets in.

Researched 2026-10-01 from upstream source at named tags, the shipped
packages and the official docs. Claude Code was additionally checked against
the installed 2.1.286. **No CLI was run against a live, logged-in session**;
what still needs that is listed under "Open items to measure live". Unknowns
are written as unknown.

## Summary

| CLI (version) | Verdict | Session id from | Resume with message | team-up uses |
|---|---|---|---|---|
| Claude Code (2.1.286) | `hook` (+ `env`) | `SessionStart` hook stdin; `CLAUDE_CODE_SESSION_ID` + `CLAUDE_PID` in tool env | `claude --resume <id> "<msg>"` (documented) | plugin hook → registry; env fallback; resume with positional prompt; pending message via `additionalContext` |
| Hermes (2026.9.24, `82c63c5`) | `env` (+ `hook`) | `HERMES_SESSION_ID` in tool env | `hermes chat --resume <id> -q "<msg>"` (cwd restored by Hermes) | env detection; resume with `-q` |
| Codex (0.159.3) | `env` (+ `hook`) | `CODEX_SESSION_ID` in tool env (root session) | `codex resume <id> -C <cwd> "<msg>"` | env detection without tmux (tools run under a shared daemon whose `$TMUX_PANE` may be another session's); resume with `-C` |
| OpenCode (2.0.21 / 1.18.34) | v2 `env`, v1 `hook` (plugin) | v2: `OPENCODE_SESSION_ID`; v1: none by default | v2: `opencode -s <id> --prompt "<msg>"`; v1: `--prompt` ignored with `-s` | env detection (v2); no automatic resume — the version split and v2's own restart recovery make it unsafe |
| Cursor CLI (2026.09.28) | `env` (unverified) + `hook` | `CURSOR_CONVERSATION_ID` (undocumented, read from the bundle); `sessionStart` hook (new chats only) | `cursor-agent --resume <id> "<msg>"` | records a Cursor chat when Cursor runs team-up's Claude hook (Cursor imports Claude hooks by default) and its process is found by name; resume with positional prompt; env var not used until measured |
| Gemini CLI (0.62.0) | `hook` | `SessionStart` hook stdin / `GEMINI_SESSION_ID` in hook env only | `gemini --resume <id> -i "<msg>"` | not yet: needs a Gemini extension hook (follow-up) |

Background work does not survive a resume in any of them: Claude Code,
Codex, Cursor, Gemini and Hermes all lose running subagents and background
shells, so the watcher is always re-spawned by the wake-up message.
OpenCode v2 is the exception that matters: its server resumes interrupted
turns and background subagents on its own.

## Claude Code

**Version:** `claude --version` → `2.1.286 (Claude Code)`. The binary is
`readlink -f $(which claude)` → `/opt/claude-code/bin/claude`, a native ELF (Bun-compiled).
There is no JS package directory, so the bundle was inspected with
`strings -n 6 /opt/claude-code/bin/claude > claude-strings.txt`. "Bundle line N" below
means line N of that output, for this exact binary. The docs were fetched on 2026-10-01
as markdown: `https://code.claude.com/docs/en/{hooks,cli-reference,env-vars,sessions,
plugins-reference,sub-agents}.md`. No interactive or API-calling claude session was
started.

### 1. Hook and plugin points at session start

- **The `SessionStart` event.** Its matcher/`source` values are `startup`, `resume`
  (`--resume`, `--continue`, `/resume`), `clear`, `compact`, and `fork` (docs: hooks,
  "SessionStart" table). `fork` replaced `resume` for forked sessions in v2.1.214.
  Bundle line 468444:
  `source:U(["startup","resume","clear","compact","fork"])`.
- **Background execution.** On interactive launch, including `--resume`, SessionStart
  hooks run in the background. Claude's first response waits for them, and a prompt sent
  meanwhile doesn't reach Claude until they finish (docs: hooks, SessionStart).
- **Other events** listed in the hooks reference include `SessionEnd`, `Stop`,
  `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`, `PreCompact`,
  `PostCompact` and `UserPromptSubmit`.
- **Plugin hooks.** A plugin's `hooks/hooks.json` is loaded automatically and merged with
  any `hooks` declared in `plugin.json` (docs: plugins-reference, "Claude Code merges
  whatever you declare with `hooks/hooks.json` when that file exists").
  `${CLAUDE_PLUGIN_ROOT}` is substituted in `command` and `args`, and is also exported as
  an env var to the hook (docs: plugins-reference table row "Hook commands"; hooks,
  "Both forms ... export them as the environment variables `CLAUDE_PROJECT_DIR`,
  `CLAUDE_PLUGIN_ROOT`, and `CLAUDE_PLUGIN_DATA`").

### 2. What the hook receives

**Stdin JSON.** The common fields are `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, plus optional `prompt_id`, `scratchpad_dir` (v2.1.257+),
`permission_mode`, `agent_id`, `agent_type` and `effort` (docs: hooks, "Common input
fields"; bundle line 468444 zod schema
`N=p(()=>u({session_id:o(),transcript_path:o(),cwd:o(),...`).

**SessionStart additions:**

- `source`, plus optional `model`, `agent_type` and `session_title`.
- On `resume` and `fork` (v2.1.251+): `seconds_since_last_response`, `context_tokens`,
  `prompt_cache_likely_expired`, `estimated_cache_write_usd`.

Sources: docs, hooks "SessionStart input"; bundle line 475808
`{...,hook_event_name:"SessionStart",source:n,agent_type:g,model:h,session_title:...}`.

**Output field name confirmed:** `hookSpecificOutput.additionalContext` with
`hookEventName: "SessionStart"`. Other fields are `initialUserMessage` (it creates the
first turn, but only in `-p` mode per the docs), `sessionTitle`, `watchPaths` and
`reloadSkills` (docs: hooks, "SessionStart decision control"; bundle lines 468444, 472503
`hookEventName:x("SessionStart"),additionalContext:o().optional(),initialUserMessage:...`).
Plain stdout on exit 0 is also added as context. All of these strings are capped at
10,000 characters.

**No pid in the JSON, but there is a pid env var.** The hook's env carries
`CLAUDE_PID` = the Claude Code process id (v2.1.214+; docs: env-vars `CLAUDE_PID`).
`CLAUDE_CODE_SESSION_ID` is also set. Bundle line 472070:
`function cNe(e){let n={CLAUDECODE:"1",CLAUDE_CODE_SESSION_ID:e.sessionId,
CLAUDE_CODE_CHILD_SESSION:"1",CLAUDE_CODE_SESSION_ATTENDED:...,CLAUDE_PID:String(process.pid)}`.

**Is the hook a direct child of `claude`? It depends on the hook form.**

- **Shell form (no `args`)** is spawned with `shell: true`, which is `sh -c` on Linux.
  - Docs: hooks, "Exec form and shell form": "`sh -c` on macOS and Linux".
  - Bundle line 475821: `to=Nse(rn,[],{env:Zn,cwd:Qt,shell:Ps,detached:Ln,...})` with
    `Ps=!0` off Windows, and `detached: !isWindows`.
  - Measured here: `/bin/sh` → `/usr/bin/dash` 0.5.12-6ubuntu5 does **not** exec a single
    simple command. In a Python driver,
    `subprocess.run("python3 pp.py", shell=True)` printed `ppid-comm sh`, while the argv
    spawn printed the Python parent.
  - So with shell form, the hook's parent is `sh`, its grandparent is `claude`, and the
    hook runs in a new session (`detached`).
- **Exec form (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs"]`)** is
  spawned directly with no shell (docs: hooks, exec form; bundle line 475821
  `else if(en)to=Nse(en[0],en[1],{env:Zn,cwd:Qt,detached:Ln,...})`). The parent is then
  `claude`.
- **Simplest option: read `$CLAUDE_PID`**, which is correct under either form.
- The current `team-up/hooks/hooks.json` uses shell form (`node "${CLAUDE_PLUGIN_ROOT}/..."`),
  so the hook's ppid is `sh`. Its `findCliProcess` walk-up is needed, or it could switch to
  `$CLAUDE_PID`.
- Measured: `/proc/$CLAUDE_PID/comm` = `claude` for the native install. An npm/Node
  install would show a different comm; that was not tested.

### 3. Session id visible to child processes

**Yes: `CLAUDE_CODE_SESSION_ID`.** It is set in Bash and PowerShell tool subprocesses,
hook subprocesses and stdio MCP servers. For Bash and hooks it matches the hook
`session_id` and updates on `/clear` (docs: env-vars `CLAUDE_CODE_SESSION_ID`).

- **Caveat:** on `--continue`, or `--resume` without an explicit id, the variable "may
  receive the initial startup ID instead". With `--resume <id>` it receives the resumed id.
- `CLAUDE_SESSION_ID` (without `_CODE_`) is only a `${CLAUDE_SESSION_ID}` text placeholder
  substituted in skills and commands (bundle: `Rn.replace(/\$\{CLAUDE_SESSION_ID\}/g,q())`).
  It is not an env var.
- **Measured in this session** (Bash tool, run by a subagent):
  `CLAUDE_CODE_SESSION_ID=eff493d8-aa57-5292-ab48-43be7dcc84e0 CLAUDE_PID=118
  CLAUDE_CODE_CHILD_SESSION=1 CLAUDECODE=1`.
  - `ps` showed pid 118 = `/opt/claude-code/bin/claude ...`, and the Bash shell's ppid was
    118.
  - The id equals the **main** session's transcript name
    (`~/.claude/projects/-home-user-team-up/eff493d8-....jsonl`), while this subagent's own
    transcript is under `.../eff493d8-.../subagents/agent-*.jsonl`.
  - So a run dispatched from inside a subagent still records the parent session id.

### 4. Resume by id from the command line, interactively in tmux

Use `claude --resume <session-id>` (`-r`). `claude --help` (2.1.286): `-r, --resume
[value]  Resume a conversation by session ID, or open interactive picker`.

- **cwd for finding the session:** not required. Since v2.1.223 the id is looked up in the
  current project and its worktrees, then in every other project on the machine, provided
  exactly one other project has it (docs: sessions, "You can run `claude --resume
  <session-id>` from any directory"; cli-reference `--resume`). Not found prints
  `No conversation found with session ID: <id>` (also in the bundle).
- **cwd the resumed session works in:** **unknown**. The docs do not say whether a
  cross-project resume switches the working directory to the original one. The bundle
  contains the picker message "This conversation is from a different directory. To resume,
  run: ..." for the picker path. Recommendation: start the tmux pane in the recorded `cwd`
  (`tmux new-session -c <cwd>`), which makes the question moot.
- **What resume restores:** history, model, agent, permission mode (with an explicit id
  and no `-p`), the active goal and unexpired scheduled tasks. `--mcp-config`,
  `--settings`, `--plugin-dir` and `--add-dir` must be passed again (docs: sessions,
  "What a resumed session restores").
- **Nested-session marker:** an interactive `claude` started under an inherited
  `CLAUDE_CODE_CHILD_SESSION` is excluded from `--resume` and history. Since v2.1.178 the
  tmux case is detected automatically, and `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`
  overrides it (docs: env-vars). This matters if team-up's restart is ever run from
  Claude's own Bash tool.

### 5. Injecting a message on resume

**Yes, as a positional prompt in interactive mode.**

- The docs list `claude -r "<session>" "query"` as "Resume session by ID or name", next to
  `claude "query"`, which "Start[s an] interactive session with initial prompt"
  (cli-reference, command table rows 16 and 21). `claude --help` shows
  `Usage: claude [options] [command] [prompt]`.
- If the session is a still-running background session, the prompt "goes to the session
  as its next turn" (docs: sessions, "Resume a running background session", v2.1.285+).
- **Not measured.** Running it would start an API-calling interactive session, which was
  out of scope. So "the positional prompt is submitted automatically on a plain resumed
  session" is **documented but not measured** on 2.1.286.
- The prompt is queued behind the background SessionStart hooks (docs: hooks,
  SessionStart).
- A prompt starting with `/` or `!` is not sent to a running background session (docs:
  sessions).

Exact syntax:

```
tmux new-session -d -s <name> -c <cwd> 'claude --resume <session-id> "<wake-up message>"'
```

Alternative for a session started without tmux: the SessionStart hook's
`hookSpecificOutput.additionalContext`. It attaches to the first turn, so it reaches Claude
only once some prompt is sent. `initialUserMessage` would create a turn, but per the docs
only in `-p` mode.

### 6. On-disk session storage

- **Location:** `~/.claude/projects/<project>/<session-id>.jsonl`. `<project>` is the cwd
  with non-alphanumerics replaced by `-`, truncated to 200 characters plus a hash when the
  name is longer. It can be overridden with `CLAUDE_CONFIG_DIR` and
  `CLAUDE_CODE_PROJECT_DIR_NAME` (docs: sessions, "Where transcripts are stored").
- **Not a stable format:** "The entry format is internal to Claude Code and changes between
  versions" (same section).
- **Retention:** 30 days (`cleanupPeriodDays`).
- **Measured line keys:** the first line is `{"type":"mode","mode":"normal","sessionId":...}`
  and message lines carry `cwd`, `sessionId` and `entrypoint`
  (`~/.claude/projects/-home-user-team-up/59e75f90-....jsonl`).
- **Subagent transcripts:** `<session-id>/subagents/agent-<id>.jsonl` plus `.meta.json`
  (measured with `ls`).
- **Mapping:** cwd → session works through the directory slug and the per-line `cwd`.
  There is **no pid on disk**, so pid → session needs the hook registry or the env var.

### 7. Do subagents and background tasks survive resume?

**No.** A background subagent, background Bash command or workflow that ended with the
previous process "shows up in the resumed transcript as a note that it didn't finish.
Claude Code doesn't start a turn from those notes". Background Bash and monitor tasks
aren't restored, while unexpired scheduled tasks are (docs: sessions, "What a resumed
session restores"). The team-up watcher must therefore be re-spawned after a resume.

### 8. Version

Claude Code 2.1.286, native binary at `/opt/claude-code/bin/claude`. Docs fetched
2026-10-01.

### Verdict

**`hook`** (SessionStart via the plugin's `hooks/hooks.json`), with **`env`** also
available:

- `session_id`, `transcript_path`, `cwd` and `source` arrive on stdin.
- `CLAUDE_PID` gives the Claude pid without walking `/proc`.
- `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` are visible in Bash-tool children, so team-up
  can also read them directly at dispatch time.

**Resume with a message: possible.** Run:

```
claude --resume <id> "<message>"
```

in a tmux pane started in the recorded cwd. This is documented in cli-reference but was not
measured here. The fallback is `hookSpecificOutput.additionalContext` from SessionStart.

## Hermes

**Source:** `github.com/NousResearch/hermes-agent`, shallow clone at commit
`82c63c505a9ff85352bad2fd7e3924055a65e3ef` (committed 2026-10-01 11:42 -0400).
`hermes_cli/__init__.py:5` has `__release_date__ = "2026.9.24"`. `pyproject.toml:7` reads
`version = "0.0.0"`, because the real version comes from an install stamp
(`hermes_cli/__init__.py:10-38`). All paths below are relative to that checkout.
Hermes is **not installed** in this container (`ls ~/.hermes` → no such directory), so
nothing below was measured at runtime. Every answer comes from reading the code and the
in-repo docs (`website/docs/...`).

### 1. Hook and extension points at session start

Hermes has three hook mechanisms (`website/docs/user-guide/features/hooks.md:15-16`,
plus the plugin hooks section at `:371`):

- **Shell hooks:** a `hooks:` block in the profile's `~/.hermes/config.yaml`. Each entry
  maps an event to a `command`. They are registered at CLI startup
  (`hermes_cli/main.py:3081-3084` → `agent/shell_hooks.py:141 register_from_config`).
  They run in CLI, gateway, TUI, Desktop and dashboard sessions (`hooks.md:1678-1680`).
- **Plugin hooks:** Python plugins under `~/.hermes/plugins/<name>/` call
  `ctx.register_hook("on_session_start", ...)` (`hooks.md:384`).
- **Gateway hooks:** `~/.hermes/hooks/<name>/HOOK.yaml` + `handler.py`. They fire only for
  messaging-gateway events such as `session:start` (`hooks.md:89`), so they are not
  relevant for the CLI.

The valid event names are `VALID_HOOKS` in `hermes_cli/plugins.py:109-150+`. They include
`on_session_start`, `on_session_end`, `on_session_finalize`, `on_session_reset`,
`pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`, `pre_api_request`,
`post_api_request`, `subagent_start`, `subagent_stop`, `pre_verify`, and streaming and
approval observers. Compression is reported to the gateway as `session:compress` only;
there is no shell-level compaction event.

**When `on_session_start` fires.** It fires on the *first turn of a new session*, not when
the process starts (`hooks.md:470`). In code it is invoked only on the "fresh build" path
of `_restore_or_build_system_prompt` (`agent/conversation_loop.py:844-868`, call at `:865`).
A resumed session whose stored system prompt still matches the runtime returns early at
`:768-830` and does **not** re-fire it. The comment at `:791` says "on_session_start not
re-fired: continuation". Exception: a resumed session whose stored prompt is stale or
missing falls through to the fresh-build path and does fire it.

**Consent requirement.** Each new `(event, command)` pair needs approval
(`agent/shell_hooks.py:547-567`; `hooks.md:1899-1906`):

- On a TTY, Hermes asks `Allow this hook to run? [y/N]` at startup.
- Off a TTY, the hook is skipped.
- Pre-approval options: `--accept-hooks`, `HERMES_ACCEPT_HOOKS=1`,
  `hooks_auto_accept: true`, or an entry in `~/.hermes/shell-hooks-allowlist.json`.

A team-up-installed hook must therefore be pre-approved, or the resumed TUI in tmux stops
at that prompt.

### 2. What a hook receives

The payload is JSON on **stdin**, built by `agent/shell_hooks.py:425 _serialize_payload`
and `:79 _payload_fields`:
`{hook_event_name, tool_name, tool_input, session_id, cwd, profile, extra}`.

- For `on_session_start`, `extra` = `{model, platform}`, from the call site at
  `conversation_loop.py:864-867`. The test fixture at `hermes_cli/hooks.py:126` agrees.
- `cwd` is `Path.cwd()` of the Hermes process (`shell_hooks.py:81-84`).
- There is **no transcript path and no pid** in the payload.

**How the hook process is spawned.** `subprocess.Popen(argv, shell=False,
process_group=0, env=build_subprocess_env(...))` (`agent/shell_hooks.py:322-341`), where
`argv = split_command_line(command)`. So:

- There is **no shell**: the hook is a direct child of the Hermes Python process, and
  `os.getppid()` in the hook is the Hermes pid. The doc says the same: "runs via
  shlex.split, shell=False" (`hooks.md:1711`).
- The hook runs in its own process group.
- On Linux the Hermes process sets its comm name to `hermes` (`hermes_cli/main.py:205-231`,
  called at `:3603`).
- The hook's env inherits `os.environ`, which includes `HERMES_SESSION_ID` (see §3).

**Output.** Optional stdout JSON `{"context": ...}` is parsed by `_parse_context`
(`shell_hooks.py:469`). That channel is honoured for `pre_llm_call` (`hooks.md`, "Inject
context for pre_llm_call"). `on_session_start` is an observer whose return is ignored
(`hooks.md:470`), so it cannot inject context.

### 3. Session id visible to child processes

**Yes: `HERMES_SESSION_ID`.**

- When the agent initialises, `_publish_session_id` sets the ContextVar and
  `os.environ["HERMES_SESSION_ID"]` (`agent/agent_init.py:1178-1201`;
  `gateway/session_context.py:81-92`).
- Delegated subagent children only write the task-local ContextVar and never overwrite the
  parent's id (`session_context.py:84-91`).
- Terminal-tool commands get a per-command env from `_make_run_env`
  (`tools/environments/local.py:716`, used at `:1002`). That env goes through
  `_finalize_child_env` → `_inject_session_context_env` (`local.py:223-238, 276-281`),
  which bridges `HERMES_SESSION_*` ContextVars into the child.
- The persistent shell snapshot explicitly *excludes* `HERMES_SESSION_*`
  (`tools/environments/base_session_env.py:14-30, 70`), so a stale id cannot leak back in
  through the snapshot.
- The test `tests/gateway/test_session_api.py:285-308` asserts that
  `_make_run_env({}).get("HERMES_SESSION_ID")` is the session's id.

**No pid env var.** There is no Hermes-pid variable for terminal children.
`HERMES_PARENT_PID` exists but belongs to dashboard and web-server spawns
(`hermes_cli/process_identity.py:263`). To find the CLI pid, walk the ppid chain to the
first process whose comm is `hermes`.

### 4. Resume by id from the command line in tmux

Use `hermes chat --resume <SESSION_ID>`; `hermes --resume <id>` also works at top level
(`hermes_cli/_parser.py:175, 267`).

- The id format is `YYYYMMDD_HHMMSS_<hex>` (`hermes_state_ids.py:24-28`;
  `website/docs/user-guide/sessions.md:222`). Resume also accepts a title or `latest`.
- The session id is kept on resume: `self.session_id = resume or new_session_id(...)`
  (`hermes_cli/cli_init_mixin.py:315`).
- **cwd is restored automatically.** `_resolve_chat_session_args` reads `sessions.cwd`
  from the DB and `chdir`s into it (`hermes_cli/main.py:1663-1676`). Opt out with
  `--no-restore-cwd`, or pin a directory with `--in DIR`.
- The default interface is the classic prompt_toolkit REPL (`display.interface: "cli"`,
  `hermes_cli/config_defaults.py:843`). `--tui` launches the Node TUI instead.

### 5. Injecting a message on resume

**Yes: `hermes chat --resume <id> -q "<message>"`, or `--query-file <path>`.**

- On a real TTY, which tmux provides, `-q` *seeds the interactive session*: the text is
  submitted literally as the first turn and the REPL stays open (`_parser.py:231-234`).
  The logic is `cli.py:852-858 _should_seed_interactive` →
  `hermes_cli/cli_single_query.py:483-494`, which sets `cli._seeded_first_message` →
  `hermes_cli/cli_tui_mixin.py:1828-1831`, which puts it on `_pending_input`.
- With `--oneshot`, `-Q`, or a non-TTY stdio, it answers and exits instead.
- `--query-file PATH` reads the message from a file with no shell interpretation
  (`_parser.py:235-239`). This is the safest choice for an arbitrary wake-up text.
- For `--tui`, the query is passed to the Node TUI as `HERMES_TUI_QUERY`
  (`hermes_cli/main_tui_launch.py:422`). I did not trace how the TUI consumes it, so for
  the TUI path this is **unknown**. The classic REPL path is confirmed from code.

### 6. On-disk session storage

- **Primary store:** the SQLite database `~/.hermes/state.db`, or `$HERMES_HOME/state.db`
  (`hermes_state.py:168`; `sessions.md:17`).
- **`sessions` table:** has `id`, `source`, `cwd`, `started_at`, `ended_at`,
  `parent_session_id`, `title`, `last_activity_at` and more
  (`hermes_state_common.py:376-425`). It has **no pid column**.
- **Schema versioning:** `SCHEMA_VERSION = 31` (`hermes_state_common.py:277`), with
  in-code migrations (`hermes_state_schema.py`). The schema is versioned and evolving, so
  reading it directly is internal-API use. `hermes sessions list` is the supported CLI
  surface (`sessions.md:81`).
- **Terminal breadcrumbs:** `~/.hermes/terminal-sessions/<terminal-id>` holds
  `{"session_id","cwd","ts"}` (`hermes_cli/terminal_breadcrumbs.py:77-91`). The
  terminal id is the tty device first (`tty-dev-pts-N`), then `TMUX_PANE` and similar
  variables (`:37-51`). Entries older than 30 days are pruned. This gives a
  tty → session mapping, but no pid.

### 7. Do subagents and background tasks survive resume?

**No.**

- **Background subagents** (`delegate_task(background=true)`) run on a daemon thread pool
  inside the owner process (`tools/async_delegation.py:1-35`). If the owner dies,
  `recover_abandoned_delegations` (`:260-300`) turns each still-running record into an
  event with `status: "unknown"` and the error "Delegation owner exited before recording
  a terminal result; outcome unknown". That event includes transcript tails and a git hint
  for the parent; the child is not restarted.
- **Background terminal processes** are checkpointed with pids, and
  `recover_from_checkpoint` (`tools/process_registry_checkpoint.py:50`) re-adopts pids
  that are still alive. Nothing survives a reboot.

### 8. Version

Commit `82c63c5` (release date 2026.9.24). The code was read but not executed: Hermes is
not installed here.

### Verdict

**`env`**, with `hook` as an option:

- Prefer `env`. `HERMES_SESSION_ID` is set in every terminal-tool child, so team-up reads
  it directly. The pid is the first ancestor whose `/proc/<pid>/comm` is `hermes`.
- `hook` (`on_session_start`) also works. It gets `session_id` and `cwd` on stdin, and
  `ppid` is the Hermes process (no shell). Two limits: it fires on the first turn rather
  than at process start and is not re-fired on resume, and it needs pre-approved consent.

**Resume with a message: possible.** Run, in tmux:

```
hermes chat --resume <id> --query-file <msgfile>
```

or `hermes chat --resume <id> -q "<msg>"`. On a TTY this seeds the interactive REPL with
the message as its first turn, and cwd is restored from `state.db` automatically.
`--accept-hooks` is needed if any unapproved shell hook is configured. Whether this also
works under `--tui` is unknown.

## Codex

**Version researched:** `openai/codex@rust-v0.159.3`, commit `01fc69f4`,
2026-09-30. It is the newest non-alpha `rust-v*` tag according to
`git ls-remote --tags`; `0.161.0-alpha.*` tags exist. Workspace version
`0.159.3` (`codex-rs/Cargo.toml:161`).

| # | Question | Answer (with source) |
|---|---|---|
| 1 | Hook points / events | **Claude-style lifecycle hooks, on by default.** Feature `hooks` (legacy key `codex_hooks`) is `Stage::Stable, default_enabled: true` (`codex-rs/features/src/lib.rs:1220-1225`). Events: `PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, SessionEnd, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt` (`codex-rs/config/src/hook_config.rs:36-61`; docs https://developers.openai.com/codex/hooks, which redirects to https://learn.chatgpt.com/docs/hooks). Config lives in `hooks.json` next to each config layer (`~/.codex/hooks.json`, `<repo>/.codex/hooks.json`) or in inline `[hooks]` tables in `config.toml` (`codex-rs/hooks/src/engine/discovery.rs:150-160, 339-343`; docs as above). Plugins can also bundle hooks (`discovery.rs:194` `append_plugin_hook_sources`). **Trust gate:** a non-managed hook only runs once its hash is trusted. Trust is stored as `[hooks.state."<key>"] trusted_hash = …` in user `config.toml` (`discovery.rs:677-718, 794-812`; `config/src/hook_config.rs:28-33`; `hooks/src/config_rules.rs:15-37`). The TUI shows a startup "review hooks / trust all / continue without trusting" picker (`tui/src/startup_hooks_review.rs:46-80`) and has a `/hooks` command (`tui/src/slash_command.rs:115`). `--dangerously-bypass-hook-trust` skips the check for one invocation (`utils/cli/src/shared_options.rs:61-64`). **Timing:** SessionStart is queued when the session is created (`core/src/session/session.rs:1915-1918`) but runs only at the start of the first turn (`core/src/session/turn.rs:320`, `core/src/hook_runtime.rs:128-163`). It does not run at TUI launch. The legacy `notify = [argv…]` setting still exists and fires only on turn completion (`hooks/src/legacy_notify.rs:13-41`). |
| 2 | What a hook receives | **Stdin JSON.** The command runs as `$SHELL -lc "<command>"` (`hooks/src/engine/command_runner.rs:390-410`) in a new session/process group (`:413`). The input JSON is written to stdin (`:259-265`). The environment is cleared and replaced by the session's env snapshot (`:418-435`). SessionStart input schema (`hooks/schema/generated/session-start.command.input.schema.json`): `session_id`, `cwd`, `transcript_path` (nullable), `hook_event_name`, `model`, `permission_mode`, `source` ∈ `startup\|resume\|clear\|compact\|fork`. `session_id` is `sess.session_id()` (`core/src/hook_runtime.rs:155-160`), which equals the root thread id (`core/src/session/session.rs:908-915`). **No pid field.** The hook's parent is the process hosting the Codex core, and by default that is **not** the TUI in the tmux pane (see Q3 caveat). Output: `hookSpecificOutput.additionalContext` is supported for SessionStart (`session-start.command.output.schema.json`). |
| 3 | Session id visible to child processes | **Yes.** Shell-tool commands get `CODEX_THREAD_ID` (current thread) and `CODEX_SESSION_ID` (root session = root thread id). `CODEX_VERSION` is also set. Sources: `protocol/src/shell_environment.rs:6-7, 150-153`; `core/src/exec_env.rs:30-50` (doc comment: "Exposes the shared root-session identity and harness version to shell commands"); applied in `core/src/unified_exec/process_manager.rs:1451`, `core/src/tasks/user_shell.rs:170`, `core/src/unified_exec/shell_snapshot.rs:115`; preserved over snapshot replay in `core/src/tools/runtimes/mod.rs:352-362`. `CODEX_THREAD_ID` is injected even when `shell_environment_policy.include_only` is set (`exec_env.rs:30-31`). In a subagent thread, `CODEX_THREAD_ID` is the child and `CODEX_SESSION_ID` is still the root (`session.rs:908-915`). **Caveat: process tree and `$TMUX_PANE`.** Interactive `codex` auto-starts and attaches to a shared local app-server daemon by default (`features/src/lib.rs:944-947` `daemon_auto_start` Stable/default true; `tui/src/startup_orchestration.rs:494-530`). Tools and hooks run in that daemon, not under the TUI process. The daemon README says "Shared clients use the environment inherited when the daemon started" (`app-server-daemon/README.md:22-24`). So a `/proc` ppid walk from a worker reaches the daemon, which is shared across sessions, and `$TMUX_PANE` seen by tools may belong to whichever terminal started the daemon. `codex --no-daemon` forces an embedded server (`tui/src/cli.rs:83-85`). Not measured. |
| 4 | Resume by id, interactive, in tmux | `codex resume <SESSION_ID> [PROMPT]`, where the id is a UUID or a session name (`cli/src/main.rs:350-373`). Example for tmux: `tmux new-window -c <cwd> "codex resume <id> -C <cwd> '<msg>'"`. **Blocking prompts to avoid:** (a) if the current dir differs from the session's dir and `tui.resume_cwd` is unset, the TUI asks which cwd to use (`config/src/types.rs:928-931`; `tui/src/session_resume.rs:66-90`). Passing `-C/--cd <dir>` forces mode `current` and skips the prompt (`session_resume.rs:34-43`; `utils/cli/src/shared_options.rs:66-68`). Setting `tui.resume_cwd = "session"` also skips it. (b) The untrusted-hooks review picker (Q1) appears if a hook is untrusted. Non-interactive alternative: `codex exec resume <id> "<prompt>"` (`exec/src/cli.rs:151-152, 183-240`). |
| 5 | Inject a message on resume | **Yes, positional prompt.** `codex resume <id> "<msg>"` sets `interactive.prompt` (test `resume_with_session_id_accepts_prompt_positional`, `cli/src/main.rs:3952-3960`; `finalize_resume_interactive`, `main.rs:2556-2585`). The resume startup path builds an initial user message from it (`tui/src/app/startup.rs:463` Resume branch, `:559` `create_initial_user_message(initial_prompt…)`), and it is auto-submitted once the thread is attached. With `--last`, a single positional is treated as the prompt (`main.rs:2570-2572`). Paste also works: the TUI enables bracketed paste (`tui/src/tui.rs:245`). The resumed SessionStart hook (source `resume`) runs on that first turn and can add `additionalContext`. |
| 6 | Storage on disk | Rollouts: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread_uuid>.jsonl`, using local time (`rollout/src/recorder.rs:1722-1744`; name parser `rollout/src/rollout_file_name.rs:39-58`). Reverted threads use `…-<thread>_<rollout_id>.jsonl` (`rollout_file_name.rs:11-13`). A background worker zstd-compresses cold rollouts (≥7 days) to `*.jsonl.zst` (`rollout/src/compression.rs:26, 336`), and `~/.codex/archived_sessions/` also exists (`rollout/src/lib.rs:86-87`), so a scanner must handle `.zst` and both dirs. The first line is a `SessionMeta` with `session_id`, `id`, `parent_thread_id`, `forked_from_id`, `timestamp`, **`cwd`**, `cli_version`, `source` (`protocol/src/protocol.rs:3123-3160`). **No pid is recorded.** Liveness: an active writer holds an flock on `$CODEX_HOME/thread-writer-locks/<thread_id>.lock` (`rollout/src/writer_lock.rs:17-19, 45-51`). The lock file stores no pid. Metadata is also in SQLite `state_5.sqlite` (`state/src/sqlite.rs:33`; the filename carries a schema version, so it changes over time). Format stability: internal, versioned by `cli_version`, not a documented contract. The `.zst` compression and the `_rollout_id` suffix are both recent changes. |
| 7 | Subagents/background after resume | **Not restarted automatically.** Subagent threads have their own rollouts (`SessionMeta.parent_thread_id`). They are reopened only when the model calls the multi-agent v1 `resume_agent` tool (`core/src/tools/handlers/multi_agents/resume_agent.rs:9-31` → `core/src/agent/control/resume.rs:14-27` → `core/src/agent/control/spawn.rs:1244-1300`, which also reopens "Open" spawn-edge descendants). Nothing on the root resume path calls this (grep found only those two callers). The in-flight turn is not continued. Unified-exec background processes die with the host process (in-memory process manager). The watcher must be re-spawned. |
| 8 | Version | Everything above is for **0.159.3**. Earlier versions were not checked. Hooks, the daemon default, and `CODEX_SESSION_ID` look recent, so `harness verify` should pin ≥0.159. |

### Verdict

**`env`, with a `hook` as backup.**

- **Session id:** the parent's shell sees `CODEX_SESSION_ID`, the root id to pass to `codex resume`. `CODEX_THREAD_ID` is also there, and it differs from `CODEX_SESSION_ID` when the dispatcher is a subagent. `team-up` can read the id directly.
- **SessionStart hook:** also works and gives `session_id`, `cwd` and `transcript_path` on stdin. It needs one-time hook trust (or `--dangerously-bypass-hook-trust`), and it fires only at the first turn.
- **pid and tmux pane:** neither source can be trusted for these. Under the default daemon, tools and hooks are children of a shared daemon, and their env is the daemon's start env. Record the tmux pane some other way, for example by matching the `codex` client process in `tmux list-panes -F '#{pane_pid}'`, or require `--no-daemon`. This needs measuring.
- **Resume with message:** supported. Run `codex resume <id> -C <cwd> "<wake-up message>"` in tmux. The positional prompt is auto-submitted, so no paste race.

## OpenCode

There are **two current lines**, both released 2026-09-30. Cover both in
`harness verify`:

- **v1:** npm `opencode-ai` dist-tag `latest` = **1.18.34** (`registry.npmjs.org/opencode-ai`, time 2026-09-30T22:38:58Z). Repo tag `anomalyco/opencode@v1.18.34`, commit `aec0b9a6`. The public docs (https://opencode.ai/docs/plugins/) describe this line.
- **v2:** npm `@opencode/cli` dist-tag `latest` = **2.0.21**. Repo tag `anomalyco/opencode@v2.0.21`, commit `8a8bd622`. This is a rewrite: new plugin API, a shared background server, and a different CLI framework.

`github.com/sst/opencode` and `anomalyco/opencode` have the same HEAD
(`63cf2361…`) according to `git ls-remote`.

### OpenCode v2 (2.0.21)

| # | Question | Answer (with source) |
|---|---|---|
| 1 | Hook points / events | In-process TS plugins via `Plugin.define({ id, setup(ctx) })` (`packages/plugin/src/README.md`). They are discovered from `plugin/` or `plugins/` dirs (`packages/core/src/plugin/source-directory.ts:7`) under config roots including `.opencode`, `.claude`, `.agents` (`packages/core/src/config/discovery.ts:41`). Runtime hooks: `ctx.session.hook(name)` for `prompt, context, compaction, generate, title, model.request, http.request, http.response, retry, experimental.ws.*` (`packages/plugin/src/promise/session.ts:138-152`); `ctx.tool.hook("execute.before"\|"execute.after")` with `sessionID` (`plugin/src/promise/tool.ts:38-62`); `ctx.shell.hook("create.before")` (env mutable, **no sessionID field**) (`plugin/src/promise/shell.ts`). **There is no explicit session-start hook.** `ctx.event.subscribe` (`plugin/src/promise/event.ts`) streams durable events: `session.created` (`sessionID`, `location`, `parentID`, …), `session.execution.started/succeeded/failed/interrupted`, `session.compacted`, `session.forked`, `session.deleted`, … (`packages/schema/src/session-event.ts:51-68, 243-260`). Plugins run inside the **background server**, not the TUI process. |
| 2 | What a hook receives | Typed JS objects, not stdin. Session hooks carry `sessionID`, `agent`, `model`. `session.created` carries `sessionID` and `location` (directory). **No pid, no tty, no tmux info.** The server is shared, so `process.env` and `process.pid` in a plugin belong to the server. |
| 3 | Session id visible to child processes | **Yes: `OPENCODE_SESSION_ID`.** The `shell` tool sets `AGENT=1`, `OPENCODE=1`, `AI_AGENT=opencode` and `OPENCODE_SESSION_ID=<sessionID>` on every command (`packages/core/src/tool/plugin/shell.ts:207-213`). A test asserts that a stale inherited value is overwritten (`packages/core/test/tool-shell.test.ts:960-980`). The base env is the **session environment**, falling back to the server env (`packages/core/src/shell.ts:258-271`). The TUI pushes its own `process.env` as the session environment: `Env.session()` (`packages/cli/src/env.ts:15-22`) is passed at launch (`cli/src/commands/handlers/default.ts:128`) and applied with `session.environment(...)` (`packages/tui/src/app.tsx:496-505`). So `$TMUX` and `$TMUX_PANE` in tool commands should be those of the attached TUI. Not measured. The process tree is the background server, so a ppid walk does not reach the TUI. |
| 4 | Resume by id, interactive, in tmux | `opencode [directory] -s <sessionID>` (`--session`). `-c/--continue` resumes the last session in the dir, and `--fork` forks (`packages/cli/src/commands/commands.ts:38-57`). If the id does not exist, a session **with that id** is created on the first prompt (`commands.ts:52-55`; `default.ts:53-60, 96-98`). The directory comes from the stored session (`packages/cli/src/session-target.ts:47-53`), so no cwd prompt was found. The TUI connects to (or starts) the background service (`default.ts:34-50`); `--standalone` uses a private server (`commands.ts:15-24`). `opencode mini -s <id>` is a minimal interactive UI (`commands.ts:341-372`). |
| 5 | Inject a message on resume | **Yes.** `opencode -s <id> --prompt "<msg>"`: the app navigates to the session with `prompt: startupPrompt` (`packages/tui/src/app.tsx:631-650`), and the session route auto-submits it once the model and agent are ready (`packages/tui/src/routes/session/index.tsx:604-610` → `current.submit()`). Alternatives without a TUI: `opencode run -s <id> "<msg>"` (`commands.ts:376-405`), or `opencode api …` against the running server (`commands.ts:100-116`; the SDK `session.prompt`/`synthetic` are in `plugin/src/promise/session.ts:154-168`). A TUI attached to the same session would see the message, because the server is shared. Not measured. |
| 6 | Storage on disk | SQLite `$XDG_DATA_HOME/opencode/opencode.db` for channels `latest/dev/beta/next/prod`, otherwise `opencode-<channel>.db`; override with `OPENCODE_DB` (`packages/cli/src/database-path.ts:4-13`; data root `packages/util/src/global.ts:12-13`). Check with `opencode debug paths` (`commands.ts:122-125`). Table `session_v2` has `id` (`ses…`, `packages/schema/src/session-id.ts:5`), **`directory`**, `parent_id`, `time_*`, `time_suspended` (execution claim), `resume_attempts` (`packages/core/src/session/sql.ts:22-75`). **No pid.** Format: internal Drizzle schema with frequent migrations (e.g. `database/migration/20260811161259_execution_claim_attempts.ts`), and there is v1→v2 migration code (`core/src/database/v1-migration.bun.ts:704-705`). Not a stable contract, but `session list` and `session export` CLI commands exist (`commands.ts:418-460`). |
| 7 | Subagents/background after resume | **Partly kept, uniquely so.** When the managed background server boots, it runs `resumeSuspendedSessions` (`packages/server/src/process.ts:232-238`; `packages/core/src/session/execution/restart.ts:35-60, 191-232`). Sessions whose turn was interrupted get a synthetic message, "The server restarted while you were working. Continue from where you left off without repeating completed work." (`restart.ts:15-16, 88-93`), and execution resumes (max 10 attempts, `restart.ts:33`). Background **subagent** jobs are resumed (`restart.ts:137-189`). Background **shell** jobs are reported "cancelled because the server restarted" (`restart.ts:105-135`). This only happens once something starts the background server after reboot. Our external watcher process is still gone and must be re-spawned. |
| 8 | Version | 2.0.21 only. |

### OpenCode v1 (1.18.34)

| # | Question | Answer (with source) |
|---|---|---|
| 1 | Hook points / events | Plugins are JS/TS modules in `{plugin,plugins}/*.{ts,js}` under config dirs (`packages/opencode/src/config/plugin.ts:21`). Docs give `.opencode/plugins/` and `~/.config/opencode/plugins/` (https://opencode.ai/docs/plugins/). `Hooks` interface (`packages/plugin/src/index.ts:222-300`): `event` (all bus events, including `session.created`, `session.idle`, `session.compacted`, `session.error`, …; `packages/sdk/js/src/gen/types.gen.ts:476, 563`), `chat.message`, `chat.params`, `tool.execute.before/after`, **`shell.env`**, `permission.ask`, `experimental.session.compacting`, … |
| 2 | What a hook receives | Plugin init gets `{ client, project, directory, worktree, serverUrl, $ }` (`plugin/src/index.ts:56-66`). Hooks get typed objects: `event` → `{ event }`; `shell.env` → `{ cwd, sessionID, callID }` (`index.ts:270-273`). The server runs in a Worker **inside the TUI process** with the TUI's env (`packages/opencode/src/cli/cmd/tui.ts:210-214`), so `process.pid` and `process.env.TMUX_PANE` in a plugin are the TUI's. Inferred from source, not measured. |
| 3 | Session id visible to child processes | **Not by default.** The shell tool env is `{...process.env, ...shell.env-plugin-output}` (`packages/opencode/src/tool/shell.ts:416-425`), and no session var is set (grep for `OPENCODE_SESSION` found nothing in v1). **A team-up plugin can add it:** `"shell.env": async ({ sessionID }, out) => { if (sessionID) out.env.OPENCODE_SESSION_ID = sessionID }`. This matches the v2 variable name. |
| 4 | Resume by id, interactive, in tmux | `opencode [project] -s <id>` / `-c` / `--fork` (`cli/cmd/tui.ts:72-110`). |
| 5 | Inject a message on resume | **Not with `--prompt`.** With `-s` the app navigates to the session without the prompt (`packages/tui/src/app.tsx:494-499`). `--prompt` is auto-submitted only on the home route (`packages/tui/src/routes/home.tsx:53-67`). Not measured. Options: (a) paste into the TUI (`pasteInject`); (b) start the TUI with `--port <n>` (network options, `tui.ts:76, 233-240`), then `opencode run --attach http://127.0.0.1:<n> -s <id> "<msg>"` (`cli/cmd/run.ts:137, 152, 190`) — untested; (c) `opencode run -s <id> "<msg>"` non-interactively, then open the TUI. |
| 6 | Storage on disk | SQLite `$XDG_DATA_HOME/opencode/opencode.db` (channel-suffixed outside latest/beta/prod; `OPENCODE_DB` override) (`packages/core/src/database/database.ts:43-55`; `core/src/global.ts:10-14`). Table `session` has `id`, `directory`, `parent_id`, … (`packages/core/src/session/sql.ts:22-60`). No pid. Legacy `storage/` JSON dir under data is still referenced (`packages/opencode/src/storage/storage.ts:224`). |
| 7 | Subagents/background after resume | Not kept. Background jobs are in-memory, instance-scoped state (`packages/opencode/src/background/job.ts:17-33`). No restart-recovery code found (grep for `resumeSuspendedSessions` / "server restarted" in v1 found nothing). |
| 8 | Version | 1.18.34 only. |

### Verdict

**v2: `env`.**

- **Session id:** `OPENCODE_SESSION_ID` is built in, and the attached TUI's `TMUX_PANE` arrives through the session environment. No hook is needed. A plugin `session.created` subscription works as a backup.
- **Resume with message:** supported. Run `opencode -s <id> --prompt "<msg>"` in tmux, and the prompt is auto-submitted. `opencode run -s <id> "<msg>"` and `opencode api` reach the shared server without a TUI.
- **Restart behaviour:** the v2 server auto-continues interrupted turns on boot by itself. The wake-up message may arrive while the session is already working, so check the `session.execution.*` events before injecting.

**v1: `hook`, via a plugin.**

- **Session id:** `OPENCODE_SESSION_ID` is not set by default. A ~5-line `shell.env` plugin adds it. That effectively makes it `env` once team-up ships the plugin. The plugin's `process.pid` and env are the TUI's.
- **Resume with message:** the `--prompt` route is not supported with `-s` according to the source. Use paste after `waitTmuxReady`, or the untested `--port` + `run --attach` route.

## Cursor CLI

**Version examined:** `2026.09.28-64d2043`. This is the build that the
official installer `https://cursor.com/install` pointed to on 2026-10-01
(`DOWNLOAD_URL=https://downloads.cursor.com/lab/2026.09.28-64d2043/linux/x64/agent-cli-package.tar.gz`,
line 85 of the install script). I downloaded and unpacked it, and
`./cursor-agent --version` printed `2026.09.28-64d2043`. The installer
links both `~/.local/bin/agent` (primary name) and `~/.local/bin/cursor-agent`
(legacy name) to the same script (install.sh lines 128-131). The CLI is closed
source. The "source" citations below point into its shipped, minified JS
bundle (`index.js`, `7000.index.js`, `190.index.js`, `9725.index.js` in the
package). Each one gives a literal string you can grep for, because the files
are minified onto very long lines.

| # | Question | Answer | Source |
|---|---|---|---|
| 1 | Hook points and events | **Yes, the CLI runs hooks.** It reads `hooks.json` from `~/.cursor/hooks.json` (user), `<proj>/.cursor/hooks.json` (project), `/etc/cursor/hooks.json` (enterprise) and team hooks. It **also reads Claude Code hooks** from `~/.claude/settings.json`, `<proj>/.claude/settings.json` and `.claude/settings.local.json`, plus plugin hooks. Agent events: `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `stop`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `afterAgentResponse`, `afterAgentThought`, `preCompact`. Other events: `workspaceOpen` (app lifecycle, "Runs in the Cursor desktop app and CLI"), plus the Tab-only `beforeTabFileRead` and `afterTabFileEdit`. Claude names are mapped as `SessionStart→sessionStart`, `Stop→stop`, `PreCompact→preCompact`, `UserPromptSubmit→beforeSubmitPrompt`, and so on. **Gotcha: in the interactive CLI, `sessionStart` fires only for a new chat, not on `--resume`.** The call is guarded by `!at&&Ot&&(...hasHooksForStep(h._E.sessionStart))`, where `at` is the resume id (`case"resume":at=Qe.sessionId,...lt=at`). The docs agree: it is "Called when a new composer conversation is created". | Docs https://cursor.com/docs/hooks (fetched as `/docs/hooks.md`: "Hook categories", "sessionStart", "workspaceOpen"). Claude compatibility: https://cursor.com/docs/reference/third-party-hooks ("on by default"). CLI changelog https://cursor.com/docs/cli/changelog, January 2026: "Hooks. Session start/end, stop hooks…; Claude Code `settings.json` hooks are read and merged". Bundle `190.index.js`: `claudeUserConfigPath:l.join((0,y.homedir)(),".claude","settings.json")`, `SessionStart:n.sessionStart`. Bundle `7000.index.js`: `!at&&Ot&&(Nt\|\|Ft\|\|Ot.hasHooksForStep(h._E.sessionStart))`. |
| 2 | What a hook receives | **JSON on stdin.** In this build it is written to the hook's stdin when direct-stdin transport is used, otherwise sent as a `<<'CURSOR_HOOK_EOF'` heredoc to the command. Fields common to all hooks: `conversation_id`, `generation_id`, `model`, `hook_event_name`, `cursor_version`, `workspace_roots[]`, `user_email`, `transcript_path`. The executor adds `session_id` (= `conversation_id`). `sessionStart` adds `session_id`, `is_background_agent` and `composer_mode`. **No pid and no cwd field.** Use `workspace_roots[0]` or `$CURSOR_PROJECT_DIR`. Env vars: `CURSOR_PROJECT_DIR`, `CURSOR_VERSION`, `CURSOR_USER_EMAIL`, `CURSOR_TRANSCRIPT_PATH`, `CLAUDE_PROJECT_DIR`, and `CURSOR_PLUGIN_ROOT`/`CLAUDE_PLUGIN_ROOT` for plugin hooks. **The conversation id is not in the hook env.** Hooks run through the CLI's shell executor, so the hook's parent is a shell and you must walk up the process tree to reach the `agent` node process. A `sessionStart` output can return `{"env":{...},"additional_context":"..."}`, but that `env` applies only to later *hooks*, not to the shell tool. | Docs https://cursor.com/docs/hooks, sections "Common schema / Input (all hooks)", "sessionStart" and "Environment Variables". Bundle `190.index.js`: `executeHookForStep` (`...void 0!==a&&{session_id:a},hook_event_name:e,cursor_version:...,workspace_roots:[this.workspacePath]...`), `buildHookEnvironment` and `executeCommandScript` (`${t.command} <<'CURSOR_HOOK_EOF'`, `this.shellExecutor.execute(...)`). |
| 3 | Session id visible to child processes? | **Yes, from the bundle; measure to confirm.** The local shell executor sets `CURSOR_AGENT=1` and, when the tool call carries a conversation id, `CURSOR_CONVERSATION_ID=<id>` on every agent shell command, including background shells. The value goes through `encodeURIComponent` with `%`→`_`, capped at 200 chars, so a UUID passes through unchanged. It also sets `CURSOR_REQUEST_ID` and `AGENT_TRANSCRIPTS=<projectDir>/agent-transcripts`. The shell snapshot script explicitly strips `CURSOR_CONVERSATION_ID` and `CURSOR_REQUEST_ID` so they do not persist across commands, which means they are injected fresh on each command. Undocumented, so it could change. Still unknown: whether the id equals the chat id shown by `agent ls` (it should, because `conversation_id` = chat id in hooks), and what a *subagent's* shell sees (its own id or the parent's). | Bundle `index.js`, module `../local-exec/dist/index.js`: `g={CURSOR_AGENT:"1"};t.conversationId&&(g.CURSOR_CONVERSATION_ID=(0,Rd.sh)(t.conversationId))`. Sanitiser `../utils/dist/workspace-paths.js`: `function o(e){let t=encodeURIComponent(e);return t=t.replace(/%/g,"_"),t.length>200&&...`. Callers pass `conversationId:t.conversationId` into `coreExecutor.execute(...)`. Strip list: `grep -viE '_proxy=\|CURSOR_SANDBOX\|...\|CURSOR_CONVERSATION_ID\|CURSOR_REQUEST_ID\|CURSOR_AGENT_STORE'`. **Measure:** run `echo $CURSOR_CONVERSATION_ID` via the agent's shell tool and compare with `agent ls`. |
| 4 | Resume by id from the command line | `agent --resume <chatId>` (or `cursor-agent --resume=<chatId>`). `agent resume` and `agent --continue` (alias `--resume=-1`) take the latest chat, and `agent ls` opens the picker. **It must be launched from the same cwd.** With an explicit id, the chat store is looked up under `chats/<md5(process.cwd())>`. Only the picker carries a cwd (`de=e.cwd`). For tmux: `tmux new-session -d -s X -c <cwd> 'agent --resume <id>'`. Interactive mode needs a TTY, and with a non-TTY stdin or stdout it switches to print/headless (`me=!0===r.print\|\|!pe\|\|ue`). Related hidden flag: `--new-session-id <uuidv4>` creates a *new* chat with an id the caller chooses. It cannot be combined with `--resume`. | Docs https://cursor.com/docs/cli/overview ("Sessions"), https://cursor.com/docs/cli/reference/parameters (`--resume [chatId]`, `--continue`, `ls`, `resume`, `create-chat`). Bundle `7000.index.js`: `else le=r.resume}` / `case"resume":at=Qe.sessionId,ct=Qe.cwd?(0,he.wk)(Qe.cwd):(0,he.r7)()`. `r7()` = `wk(process.cwd())` = `join(chats, md5(resolve(cwd)))`. Hidden option: `addOption(new f.c$("--new-session-id <uuid>","Create a new session with a caller-provided ID").hideHelp())` and `requested-session-id.ts` ("cannot be combined with --resume or --continue"). |
| 5 | Inject a message into the resumed session | **Yes, as a positional prompt:** `agent --resume <chatId> "<wake-up message>"`. The CLI takes `[prompt...]` as the "Initial prompt for the agent". Cursor's own zsh shell integration runs exactly `command agent --model auto --resume $CURSOR_AGENT_CHAT_ID "$prompt_text"` (interactive, on the TTY), so resume plus positional prompt is a supported combination. As a fallback, the TUI accepts typed or pasted input (`tmux send-keys`/paste). Inside tmux, use `Ctrl+J` for newlines because Shift+Enter is not reliable there. **Measure:** that in interactive mode (without `AGENT_CLI_EXIT_ON_COMPLETION`) the prompt is auto-submitted after history loads. | Docs https://cursor.com/docs/cli/reference/parameters ("Arguments: `prompt` — Initial prompt"), https://cursor.com/docs/cli/using ("For tmux users, use Ctrl+J"). Bundle `9725.index.js` (shell-integration script): `command agent --model auto --resume $CURSOR_AGENT_CHAT_ID "$prompt_text" <"$TTY" >"$TTY"`. Bundle `7000.index.js`: `.argument("[prompt...]","Initial prompt for the agent")`. |
| 6 | On-disk storage, stability, mapping to cwd and pid | **Chats:** `${CURSOR_CONFIG_DIR \| $XDG_CONFIG_HOME/cursor \| ~/.cursor}/chats/<md5(abs cwd)>/<chatId>/store.db`, a SQLite file with tables `meta(key,value)` and `blobs(id,data)` (content-addressed, possibly encrypted via a `blobEncryptionKey` meta key). Meta keys include `agentId`, `name`, `mode`, `createdAt`, `lastUsedModel` and `latestRootBlobId`. **Transcripts** (if enabled): `~/.cursor/projects/<slug(cwd)>/agent-transcripts/<id>/<id>.jsonl` (legacy `.txt`, or flat `<id>.jsonl`). Subagents go under `<parentId>/subagents/<subId>.jsonl`. `slug` replaces every non-alphanumeric character with `-`, so it is lossy. **Mapping to cwd:** md5 of the resolved cwd is one-way. Hash candidate cwds, for example from the team-up run record, and check that `chats/<md5>/<id>/store.db` exists. **Mapping to pid:** none on disk. The running process is `node …/index.js`, started with `exec -a "$0"`, so `ps` shows `agent` or `cursor-agent`. **Stability:** undocumented internals, so treat as unstable and use only for staleness checks. | Bundle `index.js`, `../cursor-config/dist/paths.js`: `function a(){const e=process.env.CURSOR_CONFIG_DIR;...join(homedir(),".cursor")}`. `src/state/index.ts`: `join(a(),"chats")`, `createHash("md5").update(resolve(e))`. `getDbPath(e){return join(this.chatsDir,e,"store.db")}`. `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`, `blobs (id TEXT PRIMARY KEY, data BLOB)`. Transcripts: `` `${s.O2}/${e}/${e}.${t.ext}` `` with `O2="agent-transcripts"`, and `i(e,t){return`${e}/.cursor/projects/${s(t)}`}`. Launcher script `cursor-agent` (`exec -a "$0" "$NODE_BIN" … index.js`). |
| 7 | Subagents and background tasks after resume | **Running work is not resumed**, but *completed* subagents keep their context. Changelog, July 6, 2026: "Completed subagents persist checkpoints, so resuming one restores its prior context… resuming an unavailable subagent fails clearly". Background shells are child processes of the CLI ("Exit no longer waits on … background tasks"), and nothing in the docs or bundle restarts them. Whether a subagent that was *running* at crash time is re-dispatched on `--resume`: **unknown**. I found no documentation or code for it, so assume no and re-spawn the watcher. Note: `agent persist` (Aug 26, 2026) keeps an agent alive after the terminal disconnects, but it is a live process (tmux-like server) and does not survive a reboot. | https://cursor.com/docs/cli/changelog, entries for July 6, 2026 ("Sessions and subagents"), Aug 11, 2026 ("Background task follow-ups are back") and Aug 26, 2026 ("Persistent sessions"). |
| 8 | Version | `2026.09.28-64d2043` (Linux x64 package). Hooks in the CLI date from the January 2026 changelog entry. Stdin payloads arrived in April 2026 ("Hooks accept payloads over stdin"). | Install script, changelog. |

### Verdict

**`env`**, with a `hook` fallback for new chats. A team-up command run from the
agent's shell tool should see `CURSOR_CONVERSATION_ID` (bundle evidence; one
live `echo` should confirm it). A `sessionStart` hook gets `session_id` /
`conversation_id` on stdin, but only when a chat is *created*, never on resume.
The id does not change on resume, so a registry entry written at creation stays
valid.

- **Resume with message: yes.** Use
  `tmux new-session -d -c <cwd> 'agent --resume <chatId> "<wake-up>"'`.
  The cwd must match the original, because the chat lookup is keyed on
  `md5(cwd)`. Auto-submit in interactive mode still needs a live check.
- **Gotcha:** the Cursor CLI also runs Claude Code hooks from `~/.claude/settings.json`
  (third-party imports are on by default), and possibly Claude plugin hooks.
  team-up's Claude `SessionStart` hook may therefore fire under Cursor too. It
  must detect the caller, for example by the presence of `cursor_version` in the
  input or `$CURSOR_VERSION`, so that it does not record a Cursor chat as
  `cli: "claude"`.

## Gemini CLI

**Version examined:** `v0.62.0`. This is npm `@google/gemini-cli` dist-tag
`latest` on 2026-10-01 (`npm view`; preview `0.63.0-preview.0`, nightly
`0.64.0-nightly.20261001`). The source is the tag `v0.62.0`, commit
`b460678f3db508407554afd604cc9d6635becb2a` (2026-09-29). Links below are
`https://github.com/google-gemini/gemini-cli/blob/v0.62.0/<path>#L<n>`.

| # | Question | Answer | Source |
|---|---|---|---|
| 1 | Hook points and events | **Yes.** Hooks go in `settings.json` under `hooks` (user `~/.gemini/settings.json` or project `.gemini/settings.json`), or ship in an **extension** as `hooks/hooks.json`. They are enabled by default (`hooksConfig.enabled` default `true`). Project hooks are fingerprinted, and the user is warned when one changes. Events: `SessionStart` (source `startup` \| `resume` \| `clear`), `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`, `Notification`. **`SessionStart` fires on resume too**, in both the interactive and headless paths. | `packages/core/src/hooks/types.ts#L43-L55` (enum), `#L607-L611` (`SessionStartSource`). `docs/hooks/reference.md#L245-L297`. `packages/cli/src/ui/AppContainer.tsx#L490-L506` (interactive, `resumedSessionData ? Resume : Startup`). `packages/cli/src/gemini.tsx#L939-L958` (non-interactive). `docs/extensions/reference.md#L242-L244`. `packages/cli/src/config/settingsSchema.ts#L2548-L2566`. `docs/hooks/index.md#L154-L157`. |
| 2 | What a hook receives | **JSON on stdin:** `session_id`, `transcript_path` (the session's `.jsonl`), `cwd`, `hook_event_name`, `timestamp`. `SessionStart` adds `source`. **Env:** `GEMINI_SESSION_ID`, `GEMINI_CWD`, `GEMINI_PROJECT_DIR`, `GEMINI_PLANS_DIR`, `CLAUDE_PROJECT_DIR`. `$GEMINI_SESSION_ID` etc. are also expanded inside the command string. **No pid field.** The hook is spawned as `bash -c <command>` (`shell:false`, cwd = session cwd) directly by the gemini node process, so its parent is bash or the gemini node process. Not measured: whether bash `exec`s a single command. Output: `hookSpecificOutput.additionalContext` is injected as the first history turn (interactive) or prepended to the prompt (headless). | `docs/hooks/reference.md#L46-L58`, `#L245-L258`. `packages/core/src/hooks/hookEventHandler.ts#L371-L385` (`createBaseInput`). `packages/core/src/hooks/hookRunner.ts#L347-L367` (env and spawn), `#L527-L530` (expansion). `docs/hooks/index.md#L138-L143`. `packages/core/src/utils/shell-utils.ts` `getShellConfiguration` → `{ executable: 'bash', argsPrefix: ['-c'] }`. |
| 3 | Session id visible to child processes? | **No.** Shell-tool commands get only `GEMINI_CLI=1` (plus `TERM`, `PAGER`, git overrides) on top of the possibly sanitised parent env. `GEMINI_SESSION_ID` is set **only** in the hook runner, never in the shell tool. A `SessionStart` hook cannot add env vars for later shell commands, because the output has no `env` field. | `packages/core/src/services/shellExecutionService.ts#L58-L63`, `#L569-L575`. Repo-wide grep: `GEMINI_SESSION_ID` appears only in `packages/core/src/hooks/hookRunner.ts` (and docs/tests). |
| 4 | Resume by id from the command line | `gemini --resume <uuid>` (`-r`). It also accepts `latest`, a bare `--resume` (= latest), or a 1-based index from `gemini --list-sessions`. **Resume is scoped to the project:** lookup is in `<projectTempDir>/chats` for the cwd, so it must run from the same project root (`tmux new-session -c <cwd> …`). The id is kept on resume (`sessionId: sessionData.sessionId`). Related: `--session-id <id>` starts a *new* session with an id the caller picks (errors if it exists). `--resume`, `--session-id` and `--session-file` are mutually exclusive. Known pitfall: upstream issue #24808 / #18369 ("Invalid session identifier" when the project dir differs). | `packages/cli/src/config/config.ts#L401-L419`, `#L426-L443`, `#L242-L250`. `packages/cli/src/utils/sessionUtils.ts#L457-L492` (`findSession`: UUID, then index). `packages/cli/src/gemini.tsx#L421-L429`. `docs/cli/session-management.md#L32-L53`. https://github.com/google-gemini/gemini-cli/issues/24808 |
| 5 | Inject a message into the resumed session | **Yes.** `gemini --resume <uuid> -i "<wake-up message>"`, or the documented form `gemini -r "<session-id>" "<query>"`. In a TTY a positional query becomes `promptInteractive`: it runs the prompt, then stays interactive. `-p` would run headless and exit. **Caveat (measure):** the initial-prompt effect waits for `geminiClient.isInitialized()` but not for `isResuming`, while history loading (`resumeChat`) is async in a sibling effect. Check that the wake-up lands *after* the resumed history and not in an empty context. Fallback: paste into the TUI (input is disabled while `isResuming`). | `docs/cli/cli-reference.md#L17` (`gemini -r "abc123" "Finish this PR"`). `packages/cli/src/config/config.ts#L301-L307` (`-i`), `#L543-L551` (positional → interactive), `#L695` (`question`). `packages/cli/src/ui/AppContainer.tsx#L1586-L1603` (initial prompt), `#L1503-L1510` (`isInputActive` excludes `isResuming`). `packages/cli/src/ui/hooks/useSessionResume.ts#L105-L127`. |
| 6 | On-disk storage, stability, mapping to cwd and pid | `~/.gemini/tmp/<project-id>/chats/session-<YYYY-MM-DDTHH-MM>-<first 8 of uuid>.jsonl`. The first line is the metadata record `{sessionId, projectHash, startTime, lastUpdated, kind}`, followed by message records (older `.json` is still read). Subagent chats go to `chats/<parentSessionId>/<subId>.jsonl`. `<project-id>` is **now a slug** of the project basename (`-1`, `-2` on collisions), registered in `~/.gemini/projects.json` (`projects: {path → slug}`) with a `.project_root` marker file in the slug dir. The docs still say `<project_hash>`, and the old sha256-hash dirs are migrated. **cwd mapping:** read `~/.gemini/projects.json` or `<slug>/.project_root`. **pid mapping:** none on disk. Under macOS seatbelt sandboxing the root moves to `~/.cache/.gemini`. **Retention:** sessions are auto-deleted after 30 days by default (`general.sessionRetention`). **Stability:** the format has changed twice recently (hash→slug dir, json→jsonl), so treat as unstable. | `packages/core/src/services/chatRecordingService.ts#L478-L519`. `packages/core/src/services/chatRecordingTypes.ts#L12`, `#L92-L104`. `packages/core/src/config/storage.ts#L92-L107`, `#L230-L234`, `#L285-L321`. `packages/core/src/config/projectRegistry.ts#L24`, `#L308-L309`. `docs/cli/session-management.md#L18-L20`, `#L152-L186`. |
| 7 | Subagents and background tasks after resume | **No.** Resume reloads only the conversation record (`resumeChat(history)`), and nothing re-dispatches subagents. Background shells (`is_background`) are killed when the UI exits ("Kill all background shells"), and they die with the machine on a crash. Subagent transcripts survive on disk under `chats/<parentId>/`, but they are history only. | `packages/cli/src/ui/hooks/useSessionResume.ts#L57-L101`. `packages/cli/src/ui/AppContainer.tsx#L519-L524`. `packages/core/src/tools/shell.ts#L97`, `#L160`. `packages/core/src/services/chatRecordingService.ts#L485-L495`. |
| 8 | Version | `v0.62.0` (latest stable on 2026-10-01), commit `b460678f`. The answers come from source at that tag and are not measured against a running binary. | `npm view @google/gemini-cli dist-tags` |

### Verdict

**`hook`.** A `SessionStart` hook from `settings.json` or a team-up Gemini
extension (`hooks/hooks.json`) gets `session_id`, `cwd` and `transcript_path`
on stdin, plus `$GEMINI_SESSION_ID`. It fires on startup, resume and `/clear`,
with `source` saying which. The shell tool does **not** expose the id. Its only
marker is `GEMINI_CLI=1`, so team-up has to find the session through a
hook-written registry keyed by the gemini process. Walk up the `/proc` ppid
chain from the `team-up` process to the first `node … gemini` ancestor, which
is the same pid as the hook's (grand)parent.

- **Resume with message: yes.**
  `tmux new-session -d -c <cwd> 'gemini --resume <uuid> -i "<wake-up>"'`
  (or a positional prompt in a TTY). The cwd must be the original project root.
  Check the ordering of the initial prompt against the async history load with
  one live run.

## Open items to measure live

No CLI was run against a live, logged-in session for this research. These are the checks the host still owes, per CLI:

### Codex and OpenCode

1. Codex 0.159.3: does `CODEX_SESSION_ID` equal the `codex resume` id inside the parent? What is the shell's ppid chain under the daemon versus `--no-daemon`? What is `$TMUX_PANE` in the tool env when two tmux panes share one daemon?
2. Codex: does `codex resume <id> -C <cwd> "msg"` auto-submit without any picker when hooks are trusted?
3. OpenCode v2: `printenv OPENCODE_SESSION_ID TMUX_PANE` from the agent's shell tool. Does `opencode -s <id> --prompt` submit? Does the server's restart sweep race with our wake-up?
4. OpenCode v1: is `--prompt` with `-s` really ignored? Does a `shell.env` plugin set `OPENCODE_SESSION_ID`?

### Cursor and Gemini

1. Cursor: `echo "$CURSOR_CONVERSATION_ID"` through the agent's shell tool, and compare with `agent ls`. Repeat inside a subagent.
2. Cursor: `agent --resume <id> "hello"` in tmux. Is it auto-submitted with the prior history visible? Confirm that `sessionStart` does *not* fire.
3. Cursor: if team-up installs a Claude `SessionStart` hook in `~/.claude/settings.json`, does Cursor run it, and with which payload (`cursor_version` present)?
4. Gemini: `gemini --resume <uuid> -i "hello"`. Does the model answer with the resumed context? Check `ps -o ppid` of a `SessionStart` hook to see whether bash execs it.

### Claude Code

1. `claude --resume <id> "<message>"` in tmux: is the message submitted as the first turn, with the history loaded? (Documented, not run.)
2. With the plugin installed: does `~/.team-up/sessions/<pid>.json` appear at startup, after `/clear` and after `--resume`?
