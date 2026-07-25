<!-- o9k-provenance
who: cursor:grok-4.5
when: 2026-07-25T15:41:04.855Z
why: Document delivered command allowlist / broker boundary
trigger: runtime-supervision review remediation Minor 13
host: cursor
-->
<!-- o9k-provenance
who: cursor-agent:grok
when: 2026-07-25T15:18:22.926Z
why: Document best-effort OS sandbox for trusted specialists
trigger: runtime-supervision plan Task 2
host: cursor
-->
<!-- o9k-provenance
who: cursor:grok-4.5
when: 2026-07-25T13:52:56.781Z
why: unspecified
trigger: afterFileEdit
host: cursor
-->
<!-- o9k-provenance
who: cursor:grok-4.5
when: 2026-07-25T13:44:03.449Z
why: unspecified
trigger: afterFileEdit
host: cursor
-->
<!-- o9k-provenance
who: cursor-agent:grok
when: 2026-07-25T13:19:53.457Z
why: team-up specialist package docs
trigger: plan Task 10
host: cursor
-->
# Specialists

One repository = one specialist. Packages contain `specialist.json`,
instructions, skills, and evals — never concrete model/provider names or
executable install hooks.

## Lifecycle

```bash
team-up specialist inspect <path>
team-up specialist install <path>
team-up specialist approve <id>@<version> --project <abs-path>
team-up specialist list
team-up specialist run --id <id> --call-type review --objective "..." --project <abs>
```

Approval binds project + id + version + checksum + permissions. Any checksum
or permission change requires reapproval.

## Call types

| Type | Default writes |
|------|----------------|
| consult | false |
| delegate | delegated_only |
| review | false |

Requests/results use `team-up.request/v1` and `team-up.result/v1` beside the
text mailbox for compatibility. Specialist runs set
`result_protocol: "RESULT.json"`; generic Path-B runs still close out with
`RESULT.md`.

## Permissions and fail-closed policy

Operating-system isolation via systemd-run `--user` is **best effort** for
trusted, approved specialists — not a security boundary. The launcher always
requests `enforcement: "best_effort"`: when a live semantic probe confirms
ProtectHome / NoExecPaths, the worker runs under systemd-run; when the probe
fails, launch continues without OS isolation and records an audit warning in
run state (`sandbox.enforced: false`). Callers outside that path still use
`enforcement: "required"` (fail-closed `SANDBOX_UNAVAILABLE`).

Declared filesystem and network permissions remain instructions plus audit
metadata. The home sentinel for the semantic probe stays under `$HOME`; the
no-exec probe script is created outside `$HOME` so home-hiding alone cannot
fake executable blocking.

**Command allowlists are hard at the harness/broker boundary.** Project
actions live in `.team-up/commands.json`, are checksum-bound on specialist
approval, and are snapshotted under `~/.team-up/policy-snapshots/<runId>/`
outside every worker-writable path. The MCP broker validates that approval
checksum before each action and never re-reads a worker-modifiable copy.
Token targets are **advisory** only — see budget normalization.
Legacy config booleans such as `mediated_commands: true` or
`token_budget_adapter: true` are ignored. Until a command-broker adapter is
verified:

- non-empty `permissions.commands` or `command.*` / `shell.*` / `exec.*`
  tools → `ALLOWLIST_UNENFORCEABLE` (pre-broker gate)

Starter manifests declare the approved design capabilities (including Hannes
`command.test` / `project-test` and advisory token targets). Claude is the
first verified adapter; Cursor / Codex / Hermes / OpenCode remain unsupported.

Home-installed CLIs need a **non-empty** `sandbox.runtime_paths` list when
OS isolation is actually applied.
`runtime_paths: []` is treated as not configured →
`SANDBOX_RUNTIME_UNAVAILABLE`.

## Starters

- `team-up-with-hannes` — testing (`frontier` / `max`); tools include
  `filesystem.read` + `command.test`; commands include `project-test`;
  advisory `tokens.target: 80000`
- `team-up-with-hugo` — research (`medium` / `low`); read-only project +
  optional network; advisory `tokens.target: 80000`
