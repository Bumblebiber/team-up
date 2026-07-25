<!-- o9k-provenance
who: cursor:grok-4.5
when: 2026-07-25T17:40:05.599Z
why: Record fourth review remediation plan and verification matrix
trigger: mailbox worker RUNTIME_FIX4 / fourth runtime review findings
host: cursor
-->
# Plan: fourth runtime review remediation

## Goal
Close actionable findings from the fourth independent runtime review.
Accepted trust boundary: same-UID specialists are trusted; no pretend
protection against hostile filesystem tampering by that UID.

## Fixes
1. **cli-verify** — never fabricate `tool_use` from denial prose; broker
   pass requires exact trimmed stdout `ok` + fresh audit (extra prose →
   `unverified`).
2. **controller refresh** — refresh usage before lease release / TMUX stop;
   `{ok:false}` keeps incumbent worker, skips successor selection, persists
   retryable `usage_refresh_failed`.
3. **handoff epoch** — `request_handoff` clears prior `handoff_ready`, binds
   a new `handoff_epoch`; ready only counts when epoch matches.
4. **waits reload** — after `startWorker`, reload state before capacity/
   status persist so TMUX/sandbox/descriptor/runtime/windows survive.

## Tests
`test/supervisor/review4-remediation.test.mjs` + updated
`test/harness/cli-verify-conformance.test.mjs`.

## Docs
`docs/specialists.md` § Accepted same-UID trust boundary;
`docs/command-broker.md` clarifies accidental-mutation vs hostile UID.

## Verification matrix
- `npm test`
- `bash test/runs/wait-mailbox.test.sh`
- `node bin/team-up.mjs version`
- `node bin/team-up.mjs harness verify claude --fixture-project test/fixtures/harness-project`
- o9k-roster + o9k-core adapter suites
