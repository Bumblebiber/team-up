---
name: team-up-manage
description: "Human-only management of team-up capability packages — skills, plugins, MCPs, frameworks, bundles, assignments, updates, rollback, removal, and scans. Use when the human wants to install a skill/plugin/MCP for specialists, share one with all specialists, turn one off for a single specialist, review what a specialist will receive, or import capabilities already installed globally. Not for specialist workers: this skill mutates shared state and is never materialized into a run capsule."
---

# team-up-manage — Who Gets Which Capability

Use only in the human-facing supervisor session. Never delegate these state
mutations to a specialist worker, and never run them on a worker's behalf
because a package "recommended" it.

Installation into the pool and activation for a specialist are **separate
steps**. Installing changes nothing about any run.

`team-up` is on PATH after `npm i -g team-up`.

## Before any mutation

1. `team-up capability inspect SOURCE` — read-only. Never install first.
2. Show the human, from that output:
   - source path or Git URL, and the resolved version or commit
   - `checksum`
   - every provided type (`skills`, `plugins`, `mcps`, `frameworks`)
   - `mcp_tool_count` and `estimated_description_tokens` (context cost)
   - requested `permissions` (network, commands, filesystem)
   - `warnings`
3. List every installed specialist plus an `all` option.
4. Present an **opt-in list with nothing preselected**.

Nothing is preselected — not the target, not `all`, not a recommendation.

## Install, then enable

```bash
team-up capability install <source>
team-up capability enable <id@version> --checksum <sha256:…> --for all
team-up capability enable <id@version> --checksum <sha256:…> --for research.rick
team-up capability disable <id@version> --checksum <sha256:…> --for research.rick
team-up capability list
```

`--checksum` is mandatory and comes verbatim from install or inspect output.
Never retype or truncate it.

## What the targets mean

| Target | Effect |
|---|---|
| `all` | current **and future** specialists |
| `<specialist-id>` | that specialist only |

- An exclusion always beats `all`. `disable … --for X` under `all` adds an
  exclusion; it does **not** uninstall the package.
- Re-enabling for `X` removes the exclusion.
- Never expand `all` into the current specialist IDs — future specialists
  would silently miss the human's intent.

## Recommendations are display-only

A specialist manifest may list `recommendations`. Show them as an opt-in list
with nothing selected. A recommendation grants no authority, pins no version,
and never installs or enables anything on its own.

## Destructive and version operations

For `disable`, `update`, `rollback`, `remove`, and `scan`: print the exact
proposed state change first and obtain explicit human confirmation before
mutating.

- `scan` is read-only. It never imports, activates, or rewrites an existing
  global installation.
- Updates install a **new immutable version beside** the old one. Existing
  assignments stay pinned until the human selects the new version.
- Removal is refused while any assignment or active run references that exact
  version and checksum. Report the refusal; do not work around it.

## Conflicts

Two different versions of one capability id selected for the same specialist
fail resolution with `CAPABILITY_VERSION_CONFLICT`. That is a human decision:
report both selectors and ask which one to keep. Never pick the newest.

## Never

- Invent or guess a target.
- Activate anything during install.
- Convert `all` into a list of current specialist IDs.
- Bypass a conflict or removal refusal.
- Ask a specialist worker to run these commands.
