<!-- o9k-provenance
who: cursor:grok-4.5
when: 2026-07-25T17:10:39.880Z
why: Update remediation plan after production wiring implementation
trigger: mailbox worker RUNTIME_FIX2 closeout
host: cursor
-->
# Plan: production runtime wiring remediation

## Goal
Close Critical/Important findings from second independent NOT READY review.
Production entrypoints (launcher, usage-watcher `--once`, `runs resume` /
`cancel-wait`) drive real TMUX ops via one unified start path — no injected
start/stop/control substitutes for acceptance evidence.

## Architecture (implemented)
1. **`src/supervisor/start.mjs`** — `startFromLaunchDescriptor` /
   `prepareArgvFromDescriptor` / `startSuccessorFromDescriptor`. Descriptor
   persists harness/MCP/Bash denial/sandbox/timeout/policy/profile/`limit_windows`.
2. **`buildProductionSuperviseDeps`** — real `tmux send-keys` / `kill-session` /
   start via descriptor; ingest mailbox `CHECKPOINT.json` + `CONTROL.json`
   `handoff_ready`; resume due waits after supervise tick.
3. **Lease** — `starting:pid:N` reservation → transfer to `tmux:<session>` after
   spawn; lock files record owner PID + age steal; rollback on start failure.
4. **Capacity** — exhausted chain persists report + reset decision (`auto_resume`
   false until `wait-capacity`); cancel disables crash-recovery spawn.
5. **cli-verify** — MCP stdio preflight cannot set `broker_tool=passed`; Claude
   invocation must produce exact `ok` + fresh audit row; `--allowedTools` for
   non-interactive MCP without permission bypass.
6. **Sandbox** — bind policy snapshot RO under ProtectHome; enforce
   `timeout_seconds` even when isolation not required.

## Tests
`test/integration/production-entrypoint.test.mjs` — fake `tmux` on PATH,
exercises `launchSpecialist`, usage-watcher `--once`, `runs resume` /
`cancel-wait` without injected start/stop/control callbacks.

## Verification matrix
- `npm test` → 263/263
- `bash test/runs/wait-mailbox.test.sh` → OK
- `node bin/team-up.mjs version` → `0.1.0`
- `node bin/team-up.mjs harness verify claude --fixture-project test/fixtures/harness-project`
  → `native_shell: denied`, `broker_tool: passed`, `status: verified`
- o9k-roster `scripts/roster.test.mjs` → 36/36
- o9k-core hosts tests → 10/10
