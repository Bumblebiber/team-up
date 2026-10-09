# Headless workers for codex and cursor (phase 3, v1)

TIM task ubun-1003-ns-01M40Z8P2E1HPACP90D9JGGRA8. Slim-down plan phase 3.

## Why

Driving interactive TUIs in tmux causes most run failures: 22 of 39 failed
runs were protocol-induced, 62 of 373 never wrote a HEARTBEAT, and the
observer's only useful action was clicking trust prompts. codex and cursor have
non-interactive modes. In those modes the worker's process exit is the
completion signal, and nothing has to scrape a pane.

Claude is out of scope: `-p` usage may leave the subscription limits.

## Shape: tmux stays, as a dumb process container

The headless command runs **inside the existing `startInTmux`**, wrapped by a
small Node script. `worker.tmux` stays set, so gc, stale, the dashboard
Sessions panel, telemetry pid trees, admission `alive` and wakeup all keep
working unchanged. There is no new detached supervisor, no systemd cgroup
question and no parent-env scrubbing.

```
tmux new-session … node <repo>/src/runs/headless.mjs <runId> <cli> -- codex exec … '<prompt>'
```

The worker prompt **does not change**. It is wrapped in `cmdDispatch` before
the pick, when the CLI is not yet known. The worker still writes RESULT.md and
STATUS per protocol. The wrapper is the safety net that guarantees a terminal
state when the process exits.

## Toggle: per CLI, in roster.json

The CLI runs headless when `clis.<cli>.headless_cmd` is present. It uses the
same placeholders as `cmd`, plus `{last_message}` for the absolute path of
`mailbox/LAST_MESSAGE.md`. There is no per-cell flag: threading a flag through
`parseChainEntry` → pick → spawn costs code, and the dashboard's
`normalizeChain` drops unknown keys.

Live values, added to `~/.team-up/roster.json` only after the merge (flag off
at merge):

```json
"codex":  { "cmd": [...], "headless_cmd": ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "-c", "model_reasoning_effort={effort}", "--model", "{model}", "--json", "-o", "{last_message}", "{prompt}"] },
"cursor": { "cmd": [...], "headless_cmd": ["cursor-agent", "-p", "--output-format", "stream-json", "--yolo", "--trust", "--model", "{model}", "{prompt}"] }
```

`roster.example.json` gets the codex `headless_cmd` as documentation, with the
same values. `validateRoster` (`src/roster/config.mjs`) checks
`headless_cmd`: it must be an array of strings when present.

Headless applies to the **dispatch path only**: `spawnPinnedInTmux` in
`src/roster/command.mjs`. Specialists (`specialists/launcher.mjs`) and resume
(`executeResumeAction`) keep the interactive `cmd`. Runs with
`result_protocol: "RESULT.json"` are allowed: the worker must still write
RESULT.json itself, and the wrapper never synthesizes it.

## Verified CLI facts (2026-10-09, codex-cli 0.157.0, cursor-agent 2026.10.01)

- `codex exec` with a prompt argument **reads stdin until EOF when stdin is not
  a TTY** ("Reading additional input from stdin…"), so it hangs. The wrapper
  must spawn the child with stdin `ignore` (/dev/null).
- `codex exec --json` emits JSONL: `{"type":"thread.started","thread_id":…}`,
  `item.completed` items (`item.type: "agent_message"`, `.text`), and
  `{"type":"turn.completed","usage":{…}}`. `-o FILE` writes the last agent
  message. The exit code is 0 even when the agent reports that it could not do
  the task, so exit 0 means only that the process finished cleanly.
- The `-s workspace-write` sandbox is broken on this host ("could not create
  loopback network interface"). That is why `headless_cmd` keeps the bypass
  flag, as the interactive template does.
- `cursor-agent -p --output-format json` prints one object:
  `{"type":"result","subtype":"success","is_error":false,"result":"…","session_id":"…","usage":{…}}`.
  With `stream-json`, the **last line** is expected to be the same `type:"result"`
  object. The writer must verify this with one live cursor run before relying on it.

## `src/runs/headless.mjs`: the wrapper

`node headless.mjs <runId> <cli> -- <argv…>`. The env already carries
`TEAMUP_WORKER=1` and `TEAMUP_RUN_ID` from `tmuxArgs`.

1. Spawn `argv` with `stdio: ["ignore", "pipe", "pipe"]`, in the cwd inherited
   from tmux `-c`.
2. Tee child stdout to `mailbox/OUTPUT.log` and to the wrapper's own stdout,
   so the tmux pane still shows progress. Tee stderr to `mailbox/STDERR.log`
   and to the wrapper's own stderr.
3. Heartbeat: touch `mailbox/HEARTBEAT` (UTC ISO) at start and every 60 s while
   the child lives. This means "process alive". Stale detection and admission
   keep their meaning.
4. Session id: from the first stdout line that carries one — codex
   `thread.started.thread_id`, cursor `session_id` — write
   `mailbox/SESSION_ID`. The wrapper does not write STATE: STATE belongs to the
   reconciler, and the worker side writes mailbox only. This is for a later
   resume; v1 does not read it.
5. Timeout: `HEADLESS_TIMEOUT_MS` = 4 h, a module constant with a `ponytail:`
   comment. On expiry: SIGTERM, then SIGKILL after 10 s. The run finalizes as
   failed with reason `headless timeout after 4h`.
6. Forward SIGTERM/SIGHUP received by the wrapper (gc killing the tmux session)
   to the child, then exit without finalizing. A run killed from outside is
   already terminal, or will be classified by the existing paths.
7. Finalize on child exit with `(code, signal)`, first match wins:
   1. Mailbox STATUS is already terminal (`done|failed|cancelled`): do nothing.
      The worker closed its own run.
   2. STATUS is `waiting_human`: write FAILURE.md with "worker exited while
      waiting for an answer; headless runs cannot take answers — re-dispatch
      with the answer in the prompt", followed by the QUESTIONS.md content.
      Then STATUS=failed.
   3. `code === 0` and a final message exists:
      - If the run is typed (STATE `result_protocol === "RESULT.json"`) and no
        RESULT.json exists: failed with reason "typed run exited without RESULT.json".
      - Otherwise, if no RESULT.md exists, write RESULT.md from the final
        message. Then STATUS=done.
      - The final message is `LAST_MESSAGE.md` (codex `-o`). For cursor it is
        the `.result` of the last `type:"result"` stdout line, unless that line
        has `is_error: true`, in which case go to step 4.
   4. Anything else: FAILURE.md with exit code or signal plus the last 40 lines
      of STDERR.log (fall back to OUTPUT.log when STDERR.log is empty). Then
      STATUS=failed.

   All mailbox writes go through the same rule as `cmdSetStatus`'s worker
   branch (`src/runs/runs.mjs`): FAILURE.md first, then STATUS, both with
   `atomicWriteText`. Factor that branch into an exported helper and reuse it
   instead of duplicating it. RESULT.md is written before STATUS=done.
8. Exit with the child's code.

## Dispatch wiring (`src/roster/command.mjs`)

- `buildCommand({ …, headless })` uses `clis[cli].headless_cmd` when `headless`
  is true and fills `{last_message}`. Codex trust `-c` injection applies
  unchanged (harmless in exec mode).
- `spawnPinnedInTmux`: `headless = Boolean(roster.clis[cli].headless_cmd)`.
  If headless, the argv becomes
  `[process.execPath, <abs path to src/runs/headless.mjs>, runId, cli, "--", ...built]`.
  `effectiveRunId` always exists at this point.
- `linkDispatchToRun(runId, session, { …, headless })` sets
  `state.worker.headless = true`. This is the marker for consumers and for the
  later failure-rate comparison.

## Consumer changes

- `src/runs/observe.mjs` `runObserver`: return right after loading state when
  `state.worker?.headless`. The pane is a JSON stream, there are no prompts to
  click, and judge calls cost money. Log one `{"kind":"skip","reason":"headless"}`
  line to OBSERVATION.log.
- Nothing else in v1. Do not touch gc, stale, the dashboard, telemetry,
  admission or wakeup: tmux and HEARTBEAT keep their meaning.

## Out of scope for v1, with known ceilings

- Worker questions and answers. Used in 3 of 373 runs; a headless run fails
  with the question text (step 7.2).
- Resume through `codex exec resume <id>` or `cursor-agent --resume`. SESSION_ID
  is recorded for that later.
- A slimmer headless prompt without the HEARTBEAT instructions. Change one
  variable at a time: compare exec against TUI with the same prompt first.
- Claude.

## Tests (smallest set that fails if the logic breaks)

- `test/roster/headless-command.test.mjs`: `buildCommand` picks `headless_cmd`
  and fills `{last_message}`/`{effort}`/`{model}`/`{prompt}`. Without
  `headless_cmd`, it uses `cmd`. `validateRoster` rejects a non-array
  `headless_cmd`.
- `test/runs/headless.test.mjs`: run the wrapper against a fake child (a small
  node script given as argv) with a temp `TEAM_UP_RUNS`, covering finalize
  precedence:
  - already terminal → untouched
  - exit 0 + LAST_MESSAGE.md → RESULT.md + done
  - exit 0, no final message → failed
  - exit 3 → failed with the stderr tail in FAILURE.md
  - waiting_human at exit → failed with the questions
  - typed run without RESULT.json → failed
  - HEARTBEAT exists after the start
  - SESSION_ID extracted from a codex-style first line
- An observer test: a headless STATE returns without capture calls.
- The full suite (`npm test`) stays green.

## Verification after the merge (interface, not the writer)

1. Add codex `headless_cmd` to the live roster **after the usage-spender's
   first nights, 2026-10-10 to 10-12**, so the two changes don't confound each
   other.
2. Take 20 codex runs through normal `dispatch`. Compare done-without-RESULT,
   missing HEARTBEAT and failure rate against the last 30 days of
   tmux-interactive codex runs (`state.worker.headless` absent).
3. Then cursor: verify the stream-json last line once live, add
   `headless_cmd`, and take another 20 runs.

## Docs

- `skills/dispatch/SKILL.md`: one paragraph. With `headless_cmd`, a codex or
  cursor worker runs non-interactively. The pane shows a JSON stream, the
  wrapper closes the mailbox on exit, and questions are not supported.
- TIM Interfaces entry: updated by the interface after the merge.
