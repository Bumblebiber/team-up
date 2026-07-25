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

## Docs

- [configuration.md](docs/configuration.md)
- [specialists.md](docs/specialists.md)

## Tests

```bash
npm test
bash test/runs/wait-mailbox.test.sh
```

## License

MIT
