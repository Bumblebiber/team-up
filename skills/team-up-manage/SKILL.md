---
name: team-up-manage
description: Human-only management of team-up skills, plugins, MCPs, frameworks, bundles, assignments, updates, rollback, removal, and scans.
---

# Team-up Manage

Use only in the human-facing supervisor session. Never delegate these state
mutations to a specialist worker.

1. Run `team-up capability inspect SOURCE` before installation.
2. Show source revision, checksum, provided types, context estimate,
   permissions, every installed specialist, and `all`.
3. Present an opt-in list with nothing preselected.
4. After explicit human selection, run install, then enable separately with
   `--for TARGET` and the exact `--checksum`.
5. Treat recommendations as display-only suggestions.
6. For disable, update, rollback, remove, or scan, show the exact proposed
   state change and obtain explicit human confirmation before mutation.

Never invent a target, activate during install, convert `all` into current
specialist IDs, or bypass a conflict/removal refusal.
