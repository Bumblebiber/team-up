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
text mailbox for compatibility.

## Starters

- `team-up-with-hannes` — testing (`frontier` / `max`)
- `team-up-with-hugo` — research (`medium` / `low`)
