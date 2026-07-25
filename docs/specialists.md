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

Sandbox isolation (systemd-run `--user`) enforces filesystem scope, network,
and write mode **only when a live semantic probe confirms the user manager
actually applies ProtectHome / NoExecPaths**. If the probe fails, launch
returns `SANDBOX_UNAVAILABLE` — never unsandboxed.

**Command/tool allowlists and hard `max_tokens` in JSON are not
self-enforcing.** Config booleans such as `mediated_commands: true` or
`token_budget_adapter: true` are ignored. Enforcement requires a concrete
adapter registered in team-up code (`command_adapter` / `token_adapter`).
The MVP ships **no** such adapters, so:

- non-empty `permissions.commands` or `command.*` / `shell.*` / `exec.*`
  tools → `ALLOWLIST_UNENFORCEABLE`
- `budget.max_tokens` set → `TOKEN_BUDGET_UNENFORCEABLE`

Starter manifests declare the approved design capabilities (including Hannes
`command.test` / `project-test` and both packages' `max_tokens: 80000`).
Those capabilities remain declared so the package matches the design; launch
still fails closed until a local adapter/backend can enforce them.

Home-installed CLIs need a **non-empty** `sandbox.runtime_paths` list.
`runtime_paths: []` is treated as not configured →
`SANDBOX_RUNTIME_UNAVAILABLE`.

## Starters

- `team-up-with-hannes` — testing (`frontier` / `max`); tools include
  `filesystem.read` + `command.test`; commands include `project-test`;
  `max_tokens: 80000` (unenforced until an adapter exists)
- `team-up-with-hugo` — research (`medium` / `low`); read-only project +
  optional network; `max_tokens: 80000` (unenforced until an adapter exists)
