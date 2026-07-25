<!-- o9k-provenance
who: cursor:grok-4.5
when: 2026-07-25T17:26:03.303Z
why: Document review3 remediation of launch descriptor, lease, heartbeat, conformance
trigger: mailbox worker RUNTIME_FIX3 / third runtime review findings
host: cursor
-->
# Plan: third runtime review remediation

## Goal
Close Critical/Important findings from the third independent runtime review.
Trusted specialists + best-effort OS sandbox + enforced command broker remain.

## Architecture (implemented)
1. **Authoritative launch descriptor** — stored under
   `~/.team-up/launch-descriptors/<runId>/` (checksum sidecar). `STATE.json`
   keeps only `team-up.launch-ref/v1` `{path,checksum}`. Worker Write/Edit of
   `STATE.json` cannot weaken successor argv. Missing/corrupt descriptor or
   required broker data fails closed (no raw Claude argv). Descriptor path is
   bound read-only under effective systemd isolation.
2. **Lease gate** — controller-supplied attempts require an active unreleased
   lease before spawn. `transferLeaseOwner` failure kills the just-started TMUX
   session, releases the lease, and never persists `watching`. Controller
   retries reacquire a reservation before the next start.
3. **Mailbox HEARTBEAT** — ingested before freshness/stale-lease decisions;
   persists `mailbox_heartbeat_at` and touches attempt heartbeat. Malformed
   timestamps never become eternally fresh.
4. **handoff_ready** — draft checkpoints persist, but transition planning only
   sees a checkpoint after explicit readiness (95% force path still materializes
   a partial checkpoint).
5. **refreshUsage** — production deps collect configured Claude subscription
   usage before successor resolution; failures are explicit and non-crashing.
6. **Watcher sleep** — `min(configured_tick, 60s)` while supervised runs exist.
7. **Due-wait alternate** — resume persists the selected model's `limit_windows`
   onto the authoritative descriptor + runtime.
8. **Native-shell conformance** — stream-json tool evidence required; prose
   `NATIVE_SHELL_DENIED` alone remains `unverified`.

## Tests
`test/supervisor/review3-remediation.test.mjs` — mandatory regressions.
Existing production entrypoint + supervision suites updated for launch-ref schema.

## Verification matrix
- `npm test` → 276/276
- `bash test/runs/wait-mailbox.test.sh` → OK
- `node bin/team-up.mjs version` → `0.1.0`
- `node bin/team-up.mjs harness verify claude --fixture-project test/fixtures/harness-project`
  → `native_shell: denied`, `broker_tool: passed`, `status: verified`
- o9k-roster `scripts/roster.test.mjs` → 36/36
- o9k-core hosts tests → 10/10
