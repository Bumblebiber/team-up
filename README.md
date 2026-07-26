<!-- o9k-provenance
who: cursor-agent:grok
when: 2026-07-25T15:26:34.448Z
why: Point README at runtime supervision docs
trigger: runtime-supervision plan Task 12
host: cursor
-->
<!-- o9k-provenance
who: cursor-agent:grok
when: 2026-07-25T13:19:45.773Z
why: Document standalone team-up MVP engine
trigger: plan Task 10 handoff docs
host: cursor
-->
# team-up

Standalone deterministic model roster and specialist runtime.

`team-up` owns roster policy, usage gates, mailbox runs, exact-tier profile
resolution, specialist packages, approvals, context materialization, and
worker launch. o9k keeps a thin compatibility adapter only.

## Quick start

```bash
node bin/team-up.mjs version   # 0.1.0
node bin/team-up.mjs validate
node bin/team-up.mjs pick --role <role>
node bin/team-up.mjs pick --profile frontier:max
node bin/team-up.mjs specialist inspect ../team-up-with-hannes
node bin/team-up.mjs specialist install ../team-up-with-hannes
node bin/team-up.mjs specialist approve testing.hannes@0.1.0 --project /abs/path
node bin/team-up.mjs runs create ...
node bin/team-up.mjs runs wait <run-id>
```

State lives under `~/.team-up` (override with `TEAM_UP_HOME`). Reads may fall
back to `~/.o9k` during migration; writes never touch `~/.o9k`.

## Capability isolation

`team-up` keeps shared skills, plugins, MCPs, frameworks, and bundles inert in
a content-addressed pool. Installation does not activate a package. The human
enables an exact checksum for `all` or named specialists; an explicit
exclusion wins over `all`.

Use the supervisor-only `/team-up-manage` skill or deterministic
`team-up capability` commands. Specialist recommendations are opt-in and
start unselected.

This isolates model context, not Unix files. Workers run as the same trusted
user. A harness must have a version-keyed verification record that explicitly
stores `context_isolation: "team-up.context-isolation/v1"` before it is
eligible for specialist work. Live `team-up harness verify` builds a full
canary capsule (selected vs global/unselected/excluded) and stores that token
only when the prepared launch observation exactly matches. Missing, malformed,
or partial observations stay fail-closed at `context_isolation: null`. When
`ANTHROPIC_API_KEY` is set, Claude also spawns the capsule argv under `--bare`
and withholds the token on auth/runtime failure. Codex uses a run-specific
`CODEX_HOME` and returns explicit unverified results when auth/runtime is
missing instead of "adapter not ready".

## Docs

- [configuration.md](docs/configuration.md)
- [specialists.md](docs/specialists.md)
- [command-broker.md](docs/command-broker.md)
- Runtime supervision design: `docs/specs/2026-07-25-runtime-supervision-design.md`

## Tests

```bash
npm test
bash test/runs/wait-mailbox.test.sh
```

## License

MIT
