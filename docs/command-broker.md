# Command broker

Project owners map specialist action IDs to fixed argv arrays in
`.team-up/commands.json`. Approvals bind the policy checksum. At launch,
`team-up` writes the **authoritative** approved snapshot under
`~/.team-up/policy-snapshots/<runId>/` (mode `0444`) and exposes one MCP
tool per action via `bin/team-up-command-broker.mjs`. A copy may also appear
under `<run>/policy/` for humans — that mirror is **non-authoritative**;
checksum checks and broker execution always read the home snapshot.

## Contract

- Tools accept **no** free-form arguments in MVP.
- Execution uses `spawn(..., { shell: false })` with a sanitized environment.
- There is no generic `run` / `shell` tool.
- Harness adapters must deny the native unrestricted shell and attach only
  the broker MCP server.

The technical command restriction protects normal harness tool use and
accidental mutation (wrong tool, stray shell, worker-writable policy
copies). It is **not** a defense against a hostile process sharing the
controller's Unix UID — see `docs/specialists.md` § Accepted same-UID
trust boundary.

## Adapters

| Harness | Status |
|---|---|
| Claude | Supported after `team-up harness verify claude --fixture-project …` |
| Cursor / Codex / Hermes / OpenCode | Explicitly unverified — filtered from command-requiring chains |

Adapter capability is never asserted by roster booleans. Verification records
live under `~/.team-up/harness-verification/<adapter>/<cli-version>.json`.
