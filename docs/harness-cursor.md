# cursor as a harness — what was measured, and why the token is still out of reach

Measured 2026-08-29 against `cursor-agent 2026.08.25-3e8eec8`.

The short version: **cursor isolates correctly, and cannot prove it.** The
isolation is real and reproducible. The proof the capability contract asks for
depends on a structured inventory that cursor's stream does not emit, so
`team-up.context-isolation/v1` cannot honestly be granted today — not because
the harness leaks, but because nothing in its output lets a verifier say so.

`registry.mjs` currently has `cursor: unsupportedAdapter("cursor")`. The missing
piece was never the verify runner; it is the adapter, and the adapter is
blocked on the point below.

## The isolation mechanism works

cursor keeps two things in two places, and they move independently:

| what | where | follows |
|---|---|---|
| MCP servers, rules, hooks, chats | `~/.cursor/` | `HOME` |
| credentials | `~/.config/cursor/auth.json` | `XDG_CONFIG_HOME` |

Neither lever alone does the job:

    HOME=<tmp>              → global MCP hidden, "Not logged in"
    XDG_CONFIG_HOME=<tmp>   → "Not logged in", global MCP still visible

Overriding `HOME` and bridging only `auth.json` gives both properties at once —
the same shape as `materializeClaudeAuthHome`:

    HOME=<tmp> with <tmp>/.config/cursor/auth.json copied (mode 600)
      → "✓ Logged in as …"
      → "No MCP servers configured"

So a capsule home for cursor is buildable, and its contents are known: an
isolated `HOME`, one bridged credential file, the selected MCP servers written
to `<home>/.cursor/mcp.json` (cursor has no `--mcp-config`), `--approve-mcps`,
plugins through `--plugin-dir`, frameworks through `--add-dir`, and `--trust`
for the workspace prompt.

## The blocker: no init inventory

`team-up.context-isolation/v1` is decided by
`decideContextIsolationCapability`, which needs `observed.skills`, `.plugins`,
`.mcp_tools`, `.frameworks` and a **complete** `.absent` list covering six
planted canaries. Every one of those is read out of a structured init event —
`extractStructuredInitInventory`, and eleven call sites keyed on `init.tools`.

cursor's `system/init` carries no such field:

```json
{"type":"system","subtype":"init","apiKeySource":"login","cwd":"…",
 "session_id":"…","model":"Composer 2.5","permissionMode":"default"}
```

What cursor *does* emit is typed tool frames:

```json
{"type":"tool_call","subtype":"started","call_id":"tool_7e9d…",
 "tool_call":{"readToolCall":{"args":{"path":"…"}}}}
{"type":"tool_call","subtype":"completed", …}
```

That is enough to prove **presence** — a selected MCP tool really was invoked,
with a nonce in its result. It cannot prove **absence**: a canary that is never
called produces no frame, and a frame that never appears is not evidence the
tool was missing. Absence is exactly what the six forbidden canaries are for.

Asking the model to report what it can see is not a way out. Main's hardening
refuses self-reports on purpose — see `review5-stream-proof`,
`review7-structured-proofs`, and `adversarial: guessed final JSON without
structured Skill/plugin/Read proofs fails closed`. Approximating the proof
would defeat the check rather than satisfy it.

**Two ways forward, neither of them a code change to make quietly:**

1. cursor exposes a tool inventory (an init field, or `--list-tools`-style
   output from a running session). Then the existing canary works unchanged.
2. The contract grows a second proof shape for CLIs without an inventory —
   for example, instructing the agent to attempt each forbidden canary and
   treating a structured failure frame as evidence of absence. That is a change
   to a security check and belongs in a design record, not in an adapter.

## The broker question, which matters for Codey

Codey declares `commands: ["project-test"]`, so `launcher.mjs` requires **both**
`context_isolation` and `command_broker`. An adapter earning only the first
would still be skipped for Codey — isolation alone does not get work-horse
cells for the specialist that prompted this work.

claude denies shell with `--disallowedTools Bash`; opencode with
`permission: { bash: "deny" }`. cursor has neither flag, but its binary contains
these hook names:

    beforeShellExecution   beforeMCPExecution   preToolUse   afterFileEdit

The user's own `~/.cursor/hooks.json` only uses lifecycle events
(`sessionStart`, `beforeSubmitPrompt`, `preCompact`, `stop`, `sessionEnd`), so
the deny-capable events are unexercised here. **Plausible, not proven**: nobody
has yet shown that a `beforeShellExecution` hook can return a verdict that
blocks rather than merely observes. That is the next measurement, and it is
cheap.

## Not measured

Where cursor discovers *skills*. It matters more than it looks: the canary
fixture's own skill and plugin are positive controls, so a harness with no skill
surface can never show `capsule.selected-skill` and fails closed even when every
forbidden canary is correctly absent. Left unmeasured because the inventory
blocker above makes it moot for now.

## Status of the other adapters, for context

| adapter  | record for | installed  | grants |
|----------|-----------|------------|--------|
| claude   | 2.1.259   | 2.1.259    | broker + isolation |
| codex    | 0.150.1   | 0.152.1    | nothing — 0.150.1 was verified and failed; the installed build is newer |
| opencode | 1.18.15   | 1.18.23    | nothing — version mismatch |
| cursor   | —         | 2026.09.02 | nothing — no adapter |

Verification is keyed by CLI version, so a self-update silently revokes every
grant until the new build is verified. Claude auto-updated 2.1.252 → 2.1.259 on
2026-09-03 and for a few hours no adapter on this host could launch a
specialist at all; re-verified the same day.

The codex record is honest but no longer current: 0.150.1 was verified and did
not pass, and 0.152.1 has not been checked.
The opencode record is a leftover from the superseded branch-side isolation
probe (`context_isolation_check` / `context_isolation_planted`, dated
2026-08-15), a different and weaker contract than the one main uses; it is
inert regardless because the version does not match.

**Only `claude` can run a specialist on this host.**
