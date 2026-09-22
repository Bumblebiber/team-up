# JEV triage — task difficulty → `{tier, reasoning}` profile

Status: draft · 2026-09-22 · owner: team-up (P0073)

## Constraint first: triage is not a roster role

A roster role is a chain of `cli:model` cells that `dispatch` spawns in tmux and
that reports through `mailbox/RESULT.md`. JEV (TypeSafe "System One",
`jev-latest`) has no CLI, generates no text and cannot write a RESULT. It cannot
be a `roster.models` entry either: `config.mjs` requires `account` + `reasoning`
for tiered models, `resolveProfile` requires a non-empty `spec.cli` with a
`roster.clis[cli].cmd` template, and `buildCommand` throws without one.

So triage is an **in-host HTTPS call** whose output feeds the existing
deterministic selection. JEV never names a model.

```
prompt ──► team-up triage ──► {tier, reasoning} ──► resolveProfile() ──► cli:model:effort ──► dispatch
                 │ (timeout / low confidence / no key)
                 └──────────► role default (today's behaviour, unchanged)
```

## JEV facts this design relies on

(from TIM research entry "Jev (TypeSafe System One) as a cheap decision layer", 2026-09-19)

- `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`, model `jev-latest`.
- Question types: `noul` (yes/no), `choice` (≤255 options), `score` (2–10 level ordered scale). Every answer carries `probabilities` + `confidence`.
- Latency 70–500 ms, ~32K context, $0.042 / M input tokens, output free.
- Accuracy below frontier models (vendor: 67.8 % vs 74.1 %). Treat answers as a prior, not ground truth.
- **Transport (decided 2026-09-22): OpenRouter for now**, key `OPENROUTER_API_KEY` (same env var the roster-refresh wrapper loads from `~/.hermes/.env`). Direct TypeSafe later (retention/terms); the transport is one function behind `triage.endpoint`.
- Verified live 2026-09-22 against OpenRouter:

  ```
  POST https://openrouter.ai/api/alpha/decisions
  {"model":"jev-latest","state":"<string|object|array>",
   "questions":{"tier":{"type":"score","instructions":"<question>","criteria":["<level 0>","<level 1>","<level 2>","<level 3>"]}}}
  → 200 {"model":"typesafe/jev-1.13-20260917",
         "answers":{"tier":{"type":"score","score":0,"legend":{"0":"…"},"probabilities":{"0":1,"1":0,…},"confidence":1}},
         "usage":{"input_tokens":333,"output_tokens":17,"cost":0.000013986},"provider":"TypeSafe"}
  ```

  Model id is `jev-latest` (not `typesafe/…`). `score` needs `instructions` + `criteria[]` (the ordered levels); `noul` needs `instructions`. `score` answers are probability-weighted positions on the `criteria` scale and can be fractional. Round to the nearest level index before mapping to a label. Each criterion describes a concrete task situation; terse labels alone give Jev little evidence to match. See [TypeSafe's Score documentation](https://docs.typesafe.ai/primitives/score).

## Scope

In:
1. `team-up pick --json` (shared prerequisite, also used by the dashboard spec).
2. `team-up triage --prompt-file <f> [--role <role>] [--json]` → prints the profile decision.
3. `team-up dispatch --role <role>` → runs triage automatically when `triage.enabled` and the role is allowlisted (no `--model` pin). `--no-triage` opts out for one dispatch. `--triage` remains accepted as a harmless no-op. Active mode resolves the profile and pins the resulting `cli:model` + effort; shadow mode logs only.
4. Shadow mode + decision log for measurement.

Out (YAGNI until the measurement says otherwise):
- Role classification. The caller already knows whether it wants a review or an implementation; `cmdPick` takes `--role` *or* `--profile`, never both. Revisit only if a caller appears that genuinely does not know its role.
- Using JEV as `observer` (yes/no pane decisions). Plausible second use, separate spec.
- Any JEV SDK dependency. One `fetch` call; team-up ships two deps and stays that way.

## Output contract

Two `score` questions, 4 levels each (inside JEV's 2–10 range):

| key | levels (ordered) | maps to |
|---|---|---|
| `tier` | `low`, `medium`, `high`, `frontier` | `VALID_TIERS` in `src/roster/profile.mjs` |
| `reasoning` | `low`, `medium`, `high`, `max` | `VALID_REASONING` in `src/roster/profile.mjs` |

`state` sent to JEV: the task prompt (truncated to fit ~28K tokens, head + tail),
the role name, and the role's description if one exists. No repo contents.

`team-up triage --json` output:

```json
{
  "source": "jev" | "fallback",
  "profile": { "tier": "high", "reasoning": "medium" } | null,
  "confidence": { "tier": 0.81, "reasoning": 0.64 },
  "fallback_reason": null | "disabled" | "role_not_allowlisted" | "no_key" | "timeout" | "http_4xx" | "http_5xx" | "low_confidence" | "invalid_answer",
  "latency_ms": 212
}
```

## Fallback rules

- No API key (neither `triage.key_env` in the dispatch env nor a readable `triage.key_file` entry), timeout (`triage.timeout_ms`, default 1500), non-2xx, or an answer outside the enum → `source: "fallback"`, profile `null`, caller uses the role chain exactly as today. Triage must never make dispatch fail.
- Key lookup order: env var named by `triage.key_env` first; else parse `triage.key_file` (`KEY=VALUE` lines, comments/blank lines ignored, optional surrounding quotes stripped) and take the line for `key_env`. Refuse the file (→ `no_key`, stderr warning naming the file, never the value) if group- or world-readable (`mode & 0o077`). Read at call time; do not put the key into `process.env` or child env.
- **Low confidence rounds up, not down.** A too-low tier burns a whole run and then escalates; a too-high tier wastes a little money. If `confidence.tier < triage.min_confidence` (roster config, default 0.6), bump tier one level (`frontier` stays `frontier`). Same for reasoning. Record `fallback_reason: "low_confidence"` but keep `source: "jev"`.
- `resolveProfile` returns `PROFILE_UNAVAILABLE` or an empty chain (all cells quota-blocked) → try the next tier **up**, then fall back to the role chain. Never go down.
- "Picked, but no effort" is a normal outcome, not an error: e.g. `composer-2.5` has `reasoning.medium: null`, and `'medium' in {medium: null}` is true, so it resolves with a null effort. `buildCommand` already drops the `{effort}` slot when effort is null.

## Roster config (new optional block)

```json
"triage": {
  "enabled": false,
  "mode": "shadow",
  "endpoint": "https://openrouter.ai/api/alpha/decisions",
  "key_env": "OPENROUTER_API_KEY",
  "key_file": "~/.hermes/.env",
  "model": "jev-latest",
  "timeout_ms": 1500,
  "min_confidence": 0.6,
  "active_share": 0,
  "roles": ["implementer", "researcher", "test-writer"]
}
```

- `mode: "shadow"` — triage runs and logs, dispatch still uses the role chain. `mode: "active"` — dispatch uses the triage profile when `active_share` selects the run.
- `roles` — allowlist. `planner`, `reviewer`, `advisor` stay on their fixed chains; they are frontier-by-design and their cost is the point.
- Dispatch runs triage whenever `enabled === true`, the role is in `roles`, and there is no `--model` pin. `--no-triage` opts out for one dispatch.
- API key: env var from `triage.key_env`, or optional `triage.key_file` (path, `~` expanded) as fallback — see Fallback rules. Never in `roster.json`. `config.mjs` validation rejects `triage.api_key`.

## Measurement (gate from shadow to active)

Replay over past runs is only a sanity check: of 227 runs in `~/.team-up/runs`,
139 record `worker.model`, **none** record effort, and there is no counterfactual
("would a lower tier have passed?"). So:

1. `runs create` records `base_commit` (`git rev-parse HEAD` in `--cwd`, or `null` if not git / git fails) and `base_dirty` (bool from `git status --porcelain`, `null` if not git) in `STATE.json`. Dispatch records `worker.cli`, `worker.model`, `worker.tier`, and `worker.effort`, plus a `triage` object when triage ran. The stored triage object extends the CLI output with `mode` and `applied`, so shadow/control runs can be separated from active runs. A worker's `handoff` or `pass-to` command records an escalation event in its run state.
2. Shadow mode for ≥ 2 weeks or ≥ 50 triaged runs.
3. Run `node scripts/triage-shadow-report.mjs [--runs-dir <dir>] [--format md|json] [--json] [--min-runs N] [--min-group N] [--min-diff F]`. It reads `STATE.json` only. **Bad outcome** = `status` `failed`, or `waiting_human`, or a recorded `pass-to`/`handoff` escalation (`escalations[]`). Shadow verdict over JEV shadow runs (`triage.source === "jev"`, `triage.applied !== true`): `COLLECTING` (insufficient data), `DECISION_DUE` (high/frontier bad-rate − low/medium bad-rate ≥ min-diff), `STOP` (enough data, no signal). Active verdict compares `triage.applied === true` vs control (`applied === false`): `REGRESSION`, `OK`, or `INSUFFICIENT`. Also reports `fallback_reason` counts and per-role downgrade/upgrade stats. Exit code 0 always when the report ran.
4. Signal present → canary: `mode: "active"` for a fraction of dispatches (`triage.active_share`, e.g. 0.3), rest stays on the role chain as control. Go fully active per role when the canary's failure + escalation rate is not worse than control and cost per run is lower. Thresholds recorded in TIM Decisions before the canary starts.

## Changes by file

| file | change |
|---|---|
| `src/cli.mjs` | `pick --json` for both `--role` and `--profile`: `{model, cli, effort, skipped[], quota_blocked[]}`; new `triage` command |
| `src/roster/triage.mjs` (new) | `triage({roster, prompt, role, env, fetch})` → contract above; `fetch` injected for tests |
| `src/roster/roster.mjs` | dispatch auto-triage when enabled + allowlisted; `--no-triage` opt-out |
| `src/roster/config.mjs` | validate optional `triage` block; reject `api_key` |
| `src/runs/runs.mjs` | persist `worker.effort` and `triage` in state |
| `roster.example.json` | commented `triage` block, `enabled: false` |
| `test/roster/triage.test.mjs` | fake fetch: happy path, timeout, 422, invalid enum, low-confidence round-up, PROFILE_UNAVAILABLE → next tier up → role fallback, no key |

## Open questions for Benni

1. ~~Spike via OpenRouter or TypeSafe?~~ → OpenRouter (Benni, 2026-09-22).
2. ~~Allowlisted roles?~~ → `implementer`, `researcher`, `test-writer` (Benni, 2026-09-22).
