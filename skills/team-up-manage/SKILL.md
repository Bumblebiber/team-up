---
name: team-up-manage
description: Human-only management of team-up skills, plugins, MCPs, frameworks, bundles, assignments, updates, rollback, removal, and scans.
metadata:
  team-up-scope: main
---

# Team-up Manage

Use only in the human-facing supervisor session. Never delegate these state
mutations to a specialist worker.

1. Run `team-up capability inspect SOURCE` before installation.
2. Show source revision, checksum, provided types, context estimate,
   permissions, the package's layer (`main`, `shared`, `specialist` or none),
   every installed specialist, `all`, and `host`.
3. Present an opt-in list with nothing preselected.
4. After explicit human selection, run install, then enable separately with
   `--for TARGET` and the exact `--checksum`.
5. Treat recommendations as display-only suggestions.
6. For disable, update, rollback, remove, or scan, show the exact proposed
   state change and obtain explicit human confirmation before mutation.

A `shared` package is two enables: `--for all` and `--for host`. `host` links
its skills into the host skill directory; a collision with a skill that is not
a team-up link is the human's to resolve — never move or delete it yourself.

Never invent a target, activate during install, convert `all` into current
specialist IDs, or bypass a conflict/removal refusal.
