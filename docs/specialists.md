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

Sandbox isolation (systemd-run `--user`) enforces filesystem scope, network,
and write mode. **Command/tool allowlists in JSON are not self-enforcing.**

Before executable specialist commands or `command.*` / `shell.*` / `exec.*`
tools can be enabled, the selected CLI must declare
`sandbox.mediated_commands: true` (or top-level `mediated_commands`) and a
mediated tool/command broker must exist. Otherwise launch fails with
`ALLOWLIST_UNENFORCEABLE`.

Hard `budget.max_tokens` is only advertised when the CLI declares
`sandbox.token_budget_adapter: true`. Without an adapter, omit the hard cap
and rely on the enforced `timeout_seconds` / `RuntimeMaxSec` — otherwise
launch fails with `TOKEN_BUDGET_UNENFORCEABLE`.

Starter packages request only capabilities the MVP truly enforces (no
arbitrary project command execution).

## Starters

- `team-up-with-hannes` — testing (`frontier` / `max`); consult/review + delegated mailbox artifacts
- `team-up-with-hugo` — research (`medium` / `low`); read-only project + optional network
