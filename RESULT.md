# RESULT — flaky test fix + live observer proof

## 1. Flaky test fix

`getMailboxAge reflects newest file mtime` captured `now` before `touchMailbox()` wrote the file. When the write crossed a millisecond boundary, age was 44 instead of 45.

**Fix:** After writing HEARTBEAT, read `fs.statSync(heartbeatPath).mtimeMs` and compute `nowMs = fileMtimeMs + 45_000`. Deterministic.

## 2. Ten consecutive test runs

```
Run 1:  ℹ tests 340 | ℹ pass 340 | ℹ fail 0
Run 2:  ℹ tests 340 | ℹ pass 340 | ℹ fail 0
Run 3:  ℹ tests 340 | ℹ pass 340 | ℹ fail 0
Run 4:  ℹ tests 340 | ℹ pass 340 | ℹ fail 0
Run 5:  ℹ tests 340 | ℹ pass 340 | ℹ fail 0
Run 6:  ℹ tests 340 | ℹ pass 340 | ℹ fail 0
Run 7:  ℹ tests 340 | ℹ pass 340 | ℹ fail 0
Run 8:  ℹ tests 340 | ℹ pass 340 | ℹ fail 0
Run 9:  ℹ tests 340 | ℹ pass 340 | ℹ fail 0
Run 10: ℹ tests 340 | ℹ pass 340 | ℹ fail 0
```

## 3. Live proof (real tmux, real roster judge — no mock)

Judge model (both cases): **cursor:grok-4.5-high** via `~/.o9k/roster.json` observer chain.

`scripts/live-observe-proof.mjs` kept as mocked unit harness (comment updated). Real proof: `scripts/live-observe-real.mjs`.

Also added `stall_detected` log lines to `OBSERVATION.log` with `trigger`, `mailbox_age_sec`, `silence_sec` so live proofs can name which trigger fired.

---

### Case A — silence trigger (hermes, pane moving, mailbox stale)

**Worker CLI:** real `hermes` in tmux (`hermes chat -q "say hello" --yolo`).

**Hermes status:** Started successfully but hit **`HTTP 402: Insufficient Balance`** on deepseek v4 pro (not a spawn failure — hermes ran, model call failed). Pane showed the billing error with a ticking status footer (`12s │ ✓ 9s`), so the pane kept changing while the mailbox was stale (`mailbox_age_sec: 12`, `silence_sec: 12`).

**Trigger fired:** `silence` (pane was not stalled — hermes footer kept ticking).

**OBSERVATION.log excerpt:**

```
{"ts":"2026-07-28T19:52:22.804Z","kind":"stall_detected","trigger":"silence","mailbox_age_sec":12,"silence_sec":12}
{"ts":"2026-07-28T19:52:44.590Z","kind":"judge_call","cli":"hermes","role":"implementer","elapsed_sec":12,"ok":true,"error":null,"verdict":{"state":"crashed","reason":"Hermes hit HTTP 402 Insufficient Balance on the model call and returned to a ready empty prompt, so the implementer cannot continue.","action":"escalate","keys":[],"question":"Hermes/deepseek v4 pro returned HTTP 402 Insufficient Balance — top up credits or switch model/provider for run 20260728T195210Z-o16q?","evidence":"❯ say hello / ┊  HTTP 402: Insufficient Balance / ─ ready │ deepseek v4 pro │ 12s │ ✓ 9s / ❯"}}
{"ts":"2026-07-28T19:52:44.590Z","kind":"decision","proposed_action":"escalate","action":"escalate","reason":"judge requested escalate","keys":null}
```

Run escalated to `waiting_human`. No keys sent.

---

### Case B — fresh-mailbox refusal (trust dialog, heartbeating mailbox)

**Worker CLI:** `cursor-agent` trust dialog (fixture displayed via `cat` in tmux 120×40). HEARTBEAT touched every 2 s (`mailbox_age_sec: 0`).

**Trigger fired:** `pane` (frozen trust prompt; mailbox fresh so silence trigger did not fire).

**Judge** (`cursor:grok-4.5-high`) proposed `answer` with key `a`. **Code downgraded to `wait`** — no keys sent.

**OBSERVATION.log excerpt:**

```
{"ts":"2026-07-28T20:01:09.775Z","kind":"stall_detected","trigger":"pane","mailbox_age_sec":0,"silence_sec":120}
{"ts":"2026-07-28T20:01:25.608Z","kind":"judge_call","cli":"cursor-agent","role":"implementer","elapsed_sec":6,"ok":true,"error":null,"verdict":{"state":"waiting_input","reason":"Cursor Agent is blocked on the Workspace Trust Required prompt asking whether to trust the directory.","action":"answer","keys":["a"],"question":"","evidence":"⚠ Workspace Trust Required / Do you trust the contents of this directory? / ▶ [a] Trust this workspace / [q] Quit"}}
{"ts":"2026-07-28T20:01:25.609Z","kind":"decision","proposed_action":"answer","action":"wait","reason":"mailbox fresh; worker likely alive despite frozen pane","keys":null}
```

---

## Gaps / decisions for you

1. **Hermes 402:** Case A used real hermes but the worker is blocked on insufficient balance, not a trust dialog. The silence trigger still fired correctly (pane moving + stale mailbox). To re-run with a funded hermes trust-dialog scenario, top up or switch model.

2. **Judge key `a`:** Real judge proposed lowercase `a` for trust dialog. If honoured (stale mailbox), this would hit the allowlist downgrade (`disallowed key: a`) since only `Enter`, `Down`, etc. are allowed. Separate issue from fresh-mailbox guard; not exercised here because mailbox was fresh.

## Commit

`feature/adaptive-pane-observation` — flaky test fix, `stall_detected` logging, `scripts/live-observe-real.mjs`.

## Decision-Log Data

```
## Decision-Log Data
task_type: bugfix
lane: small
agents_used: cursor:grok-4.5-high
review_cycles: 2
outcome: done
notable: Fixed ms-boundary flake; live proof via real tmux+roster judge for silence trigger and fresh-mailbox downgrade
```
