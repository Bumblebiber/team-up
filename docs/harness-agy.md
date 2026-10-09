# agy (Google Antigravity CLI) — what was measured, and what team-up needs

Measured 2026-10-09 against `agy 1.3.2` (`~/.local/bin/agy`, native Go ELF,
process name `agy`). Account: Google AI Pro, consumer OAuth. Successor of
gemini-cli (still installed: `gemini 0.63.0`, not in the roster).

The short version: **agy is the easiest CLI to wire so far.** Headless mode
emits one clean JSON envelope, and the limits come from a zero-token
`/usage` call that returns JSON. No PTY scraping, no credential handling.

## State and auth

| what | where |
|---|---|
| CLI settings, permissions, conversations, logs | `~/.gemini/antigravity-cli/` (`settings.json`, `conversations/`, `log/`, `cli.log`) |
| OAuth token (file fallback, no Secret Service here) | `~/.gemini/antigravity-cli/antigravity-oauth-token` (0600) |
| global MCP servers | `~/.gemini/config/mcp_config.json` (empty; `agy mcp add`) |
| global skills | `~/.gemini/skills/` (shared with gemini-cli) and `~/.gemini/config/` |
| built-in skills | `~/.gemini/antigravity-cli/builtin/skills/` (8) |
| workspace customizations | `.agents/` walking up to the repo root; rules from `AGENTS.md`, `GEMINI.md`, `.agents/rules/*.md` |

`~/.gemini/settings.json` (with the `tim` MCP server) is gemini-cli's file —
agy ignores it: `agy mcp list` → "No MCP servers configured".

No env var relocates the state dir (binary strings: `GEMINI_API_KEY`,
`GOOGLE_GEMINI_BASE_URL`, `ANTIGRAVITY_*` internals; `ANTIGRAVITY_EXECUTABLE_DATA_DIR`
untested). **`HOME` is the lever:** `HOME=<tmp>` plus a symlink of
`antigravity-oauth-token` into `<tmp>/.gemini/antigravity-cli/` → logged in,
`/skills` shows only the 2 mounted built-ins, `/usage` works; the symlink
survived several runs. Same shape as `materializeClaudeAuthHome`, with the same
cost: `HOME` also moves git identity, `gh` and ssh.

API-key mode exists (`"modelProvider": "gemini"` in settings + `GEMINI_API_KEY`)
but bills the Gemini API, not the subscription.

## Headless

    agy -p "<prompt>" --output-format json|stream-json [flags]

- `-p` takes the **next argv element** as the prompt. `agy -p --output-format json`
  fails ("-p took --output-format as its prompt"). No stdin prompt unless
  `--input-format stream-json`. Template order: `-p {prompt}` first.
- A prompt starting with `/` runs a slash command. `--disable-slash-commands`
  sends it to the model as text.
- `json` envelope: `conversation_id`, `status` (`SUCCESS|ERROR|CANCELED|INTERRUPTED|INVALID|WAITING|RUNNING`),
  `response`, `error`, `duration_seconds`, `num_turns`,
  `usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}`,
  `denied_actions[]` (when a tool was soft-denied), `structured_output` (with `--json-schema`).
- `stream-json`: NDJSON `{"event":"init"|"step_update"|"result", "<event>":{…}}`.
  The final line is `{"event":"result","result":<json envelope>}`; every event carries `conversation_id`.
- Resume: `--conversation <id>` or `-c` (latest).

### Exit codes lie — judge by `response`

| case | exit | status | response | stderr |
|---|---|---|---|---|
| normal | 0 | SUCCESS | text | — |
| shell tool without permission | **0** | SUCCESS | `""` | "no output produced — a tool required the "command" permission…", `denied_actions:[{action:"command"}]` |
| `--print-timeout` hit | **0** | SUCCESS | `""` | `[agy] print timeout after 10s with turn in progress; returning partial output` |
| unknown model / invalid effort | 1 | ERROR | `""` | `invalid model selection …` (no turn, 0 tokens) |

On timeout agy exits and **leaves the tool's child running** (`sleep 30` orphaned).
Kill the process group.

`--print-timeout`: `--help` says default `0s` (wait), the docs say `5m`. Pass `0`
explicitly and let team-up own the deadline.

### Permissions

- Default `permission_mode` is `request-review`: workspace file read/write is
  auto-allowed, shell commands are soft-denied (see table).
- `--dangerously-skip-permissions` → `always-proceed`, shell runs.
- Scoped alternative: `permissions.allow` / `deny` in
  `~/.gemini/antigravity-cli/settings.json`, e.g. `"command(git)"`.
- `--sandbox` / `enableTerminalSandbox`: nsjail on Linux.
- `--mode plan|accept-edits` exists; not measured.

## Models and effort

`agy models` (network, 1.3 s; "Fetching available models..." on **stderr**,
stdout is `<id>\t<label>` lines) lists effort-suffixed ids. `--model` also takes
the bare id plus `--effort`; invalid pairs fail before any turn:

| `--model` | `--effort` accepted | quota group |
|---|---|---|
| `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash` | low, medium, high | Gemini |
| `gemini-3.1-pro` | low, high | Gemini |
| `claude-opus-4-6-thinking`, `claude-sonnet-4-6` | none (flag rejected) | Claude and GPT |
| `gpt-oss-120b` | medium only | Claude and GPT |

Roster: a `reasoning` map per Gemini model (e.g. 3.1-pro `{max:"high",high:"high",medium:"high",low:"low"}`),
no `reasoning` for the Claude models so `{effort}` stays empty and `buildCommand`
drops the flag.

## Limits

    agy -p "/usage" --output-format json

0 turns, 0 tokens, ~0 s. `command.data.groups[].buckets[]`:

    {"id":"gemini-weekly","window":"weekly","remaining_fraction":0.99992,"reset_time":"2026-10-16T12:52:05Z"}
    {"id":"gemini-5h","window":"5h",…}
    {"id":"3p-weekly",…}   {"id":"3p-5h",…}

Two groups ("Gemini Models": Flash + Pro; "Claude and GPT models": Opus, Sonnet,
GPT-OSS), each with a weekly limit (tied to the tier) and a 5-hour limit.
Quota is consumed proportionally to token cost. Window names for team-up:
`agy:gemini-weekly`, `agy:gemini-5h`, `agy:3p-weekly`, `agy:3p-5h`. Every agy
model needs explicit `limit_windows` — an agy-hosted Claude model has
`provider: anthropic`, and without windows the gate falls back to the Anthropic
subscription.

`/credits` → `{"remaining_credits":0,"upgrade_uri":…}` (G1 credits, used only
with `useG1Credits:true` after the plan quota is gone). Backend calls behind
it: `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` /
`retrieveUserQuotaSummary` — not needed, `/usage` wraps them.

The limit-hit banner text was not observed (quota never ran out). Binary strings
hold `RESOURCE_EXHAUSTED` and "Quota exhausted".

Other print-mode slash commands: `/skills`, `/agents` work; `/mcp` errors
("not available in print mode").

## Skills

- **Built into agy** (8): `agy-customizations`, `antigravity-guide`, `automation`,
  `generative_ui`, `migrate-workflows`, `permissioned-github`, `plugin`,
  `ui-plugin-navigation`. Only the first two are mounted by default.
- **Global, picked up today:** 18 `tim-*` skills in `~/.gemini/skills/`.
  The 22 `hmem-*` skills moved out of that directory.
- **Plugins:** `agy plugin import claude|gemini` imports existing plugins;
  marketplace `antigravity-plugins-official` (Google Workspace, Android CLI, …).
- **Community skills for driving agy from Claude:** `oaustegard/claude-skills`
  `invoking-antigravity`, `amelnagdy/delegate-skills` `agy-delegate`,
  `iicmaster/antigravity-plugins`, `SafeMantella/claude-code-agy-CLI-skill`.
  team-up does not need them — dispatch already owns the spawn.

## team-up wiring

Templates (prompt position verified):

    "agy": {
      "cmd": ["agy", "--dangerously-skip-permissions", "--model", "{model}", "--effort", "max", "-i", "{prompt}"],
      "headless_cmd": ["agy", "-p", "{prompt}", "--output-format", "stream-json", "--print-timeout", "0",
                       "--dangerously-skip-permissions", "--model", "{model}", "--effort", "max"]
    }

The first interactive tmux attempt used a temporary `HOME` and stopped at agy's first-run Google interaction-data consent screen without accepting it. A second attempt used the real `HOME` and a fresh scratch workspace. Before launch, the trust helper added that exact workspace path to `trustedWorkspaces`; agy replied `PONG`, returned to its `>` prompt, and kept the tmux session alive for five seconds. The session was killed and the temporary trust entry removed. The account's data-use choice was not changed. The trust helper runs only for interactive agy launches; headless `-p` does not need workspace trust.

Account: `accounts.gemini` (`kind: subscription`, `plan: pro`) — `PLAN_TIERS.gemini`
and the dashboard label `gemini: "Google"` already exist; models set
`account: "gemini"`, `cli: ["agy"]`. Collector and windows key on the cli (`agy`).

Must change together (else silent failures):

1. Headless allowlists: `src/roster/config.mjs` (`headless_cmd` codex/cursor/agy),
   `src/runs/headless.mjs` `parseArgs`; tests `test/roster/headless-command.test.mjs`,
   `test/runs/headless.test.mjs`.
2. `src/runs/headless.mjs` `finalMessageFor` + session id: last `event:"result"` line →
   `result.response`, id `result.conversation_id`. Empty response or non-empty
   `denied_actions` = failed (exit 0 is not success, see table).
3. Usage: an `agy` branch in `src/usage/usage-collect.mjs` (JSON path, like
   claude/codex) calling `/usage`; windows in `src/usage/usage-windows.mjs`;
   watcher trio hard-codes in `src/usage/usage-watcher.mjs` (`computeState`,
   defaults), `src/usage/usage-procs.mjs` `CLI_BINARIES`;
   `scripts/usage-watchdog.mjs`, `src/dashboard/server.mjs` default subs,
   `scripts/usage-spender.py` `WINDOWS`.

Small additions: `src/roster/pass-to.mjs` `KNOWN_CLIS` + `/^gemini/ → agy`;
`src/collectors/cli-models.mjs` `LIST_ARGS.agy = ["models"]` + parser (tab-split);
`src/runs/parent.mjs` `CLI_PROCESS_NAMES.agy`; `src/runs/wakeup.mjs`
(`--conversation <id> -i <msg>`); `src/runs/observe.mjs` `buildJudgeArgv`
(interactive fallback would hang); `src/dashboard/installers.mjs`,
`providers.mjs`, `tim.mjs` `PROMPT_CLIS`, `public/app.js` `PROVIDER_TOKENS`;
`roster.example.json`; skills `dispatch` + `roster`; `README.md`.

Out of the first pass: harness adapter for capsules (`src/harness/registry.mjs`
is claude-only by design), isolation canary leg.
