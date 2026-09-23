# team-up dashboard v2 — connect providers, see models, install CLIs

Status: accepted · 2026-09-23 · owner: team-up (P0073) · extends `2026-09-22-dashboard-v1-design.md` · depends on the key-file rules in `2026-09-22-jev-triage-design.md`

Driver: bringing up a **new** machine — all five CLIs and `OPENROUTER_API_KEY`
already exist on this host, so v2 is an onboarding path, not a repair tool. v1
was read-only; v2 is the first version that writes secrets and executes
installers, which is a different security problem (§4).

## Decision 0: "provider" means three different things — split them first

`grep -rn 'ANTHROPIC_API_KEY\|OPENAI_API_KEY' src/` returns nothing. team-up
itself consumes exactly **one** API key. Everything else the ticket calls a
provider is owned by a CLI, or is a subscription with no key at all.

| kind | who reads the credential | members (verified) | what "connect" means |
|---|---|---|---|
| **A — team-up key** | team-up code: `src/collectors/openrouter-{models,benchmarks}.mjs`, `src/roster/triage.mjs` | OpenRouter only | dashboard writes the key to a file, validates it |
| **B — CLI subscription login** | the CLI's own credential store | `claude`, `codex`, `cursor` (`roster.subscriptions`, `accounts.*.kind: "subscription"`) | dashboard *starts* an interactive login; a human finishes it |
| **C — CLI-owned key** | the CLI's own config | `opencode` (`opencode providers`), `hermes` (`~/.hermes/.env`) | same as B — the CLI owns the store, team-up does not mirror it |

Anthropic and Cursor are **class B, not providers**: an `ANTHROPIC_API_KEY`
would be a second, billed path to a model the roster already reaches through the
`claude` subscription. v2 does not offer it. The only key v2 stores is
`OPENROUTER_API_KEY` — that is the whole of §1.

## 1. Providers

### Where the key lives — `~/.team-up/secrets.env`, not `~/.hermes/.env`

Continuity argues for `~/.hermes/.env` (0600, already holds the key, already
the `triage.key_file` default). Blast radius wins: that file is Hermes-owned and
holds `SUDO_PASSWORD=` among 17 keys, so a dashboard write path into it turns a
leaked dashboard token into the host's sudo password. v2 writes only to a
team-up-owned file. **Confirmed by Benni 2026-09-23.**

- Write target: `~/.team-up/secrets.env`, 0600, `KEY=VALUE` lines.
- Read order stays env → file, and the file list becomes
  `[~/.team-up/secrets.env, triage.key_file]` — so the existing
  `~/.hermes/.env` keeps working untouched and nothing has to be migrated.
- Parser and the 0600 refusal are already written: `parseEnvFileLine` and the
  `mode & 0o077` check in `lookupTriageKey` (`src/roster/triage.mjs`).

**Refactor this requires (not optional).** `fetchModels`/`fetchBenchmarks`
default to `process.env.OPENROUTER_API_KEY` *only*. Without a change, a key the
dashboard writes reaches `triage` and `team-up refresh` still dies with
`OPENROUTER_API_KEY required`. Move the resolver body to `src/keys.mjs` as
`lookupKey({ keyName, keyFiles, env, warn })`; `lookupTriageKey` becomes a
three-line wrapper; both collectors call `lookupKey` for their default. Key is
read at call time, never put into `process.env` or a child env, never logged.

### Atomic 0600 write

`atomicWriteText` (`src/json-store.mjs:21`) writes the tmp file under the
process umask and renames — it cannot produce 0600. Add an options argument:
`atomicWriteText(path, text, { mode })`, applied to the **tmp file before the
rename**. Precedent for the value is `ensureDashboardToken`
(`src/dashboard/server.mjs`), which does `writeFileSync(…, {mode: 0o600})` +
`chmodSync`. One helper, two callers, no parallel writer.

### The browser never sees the key

`GET /api/providers` returns per provider: `id`, `class` (A/B/C), `configured`,
`hint` (last 4 chars, e.g. `…a91f`), `source` (`env` | `file`),
`last_validated_at`, `last_verdict`. No full value, in any direction but in.
`sanitizeForDashboard` (`src/dashboard/data.mjs`, strips
`/key|token|secret|password/i`) stays the last-line filter on every response.

### Validation — `GET /api/v1/key`, not `/api/v1/models`

Verified live 2026-09-23, unauthenticated: `/api/v1/models` → **200**,
`/api/v1/key` → **401**, `/api/v1/credits` → 401, `/api/v1/benchmarks` → 401.
So the endpoint `fetchModels` uses is public and would green-light a typo.

| step | call | UI |
|---|---|---|
| connect | `GET https://openrouter.ai/api/v1/key`, `Authorization: Bearer <new key>` | — |
| 200 | key written, then re-validated from the file | green `connected · …a91f · label/limit from the response` |
| 401/403 | **nothing is written** | red `rejected by OpenRouter (401) — key not saved` |
| timeout / network | nothing written | amber `could not reach OpenRouter — key not saved`, retry button |

Validate-before-write is the point: a typo fails at connect time, not in a
`no_key` fallback weeks later. `POST /api/providers/openrouter/validate` re-runs
the check against the stored key on demand and on dashboard start.

### Rotation and removal — in scope

Rotation is the reason keys leak, so it must not require a terminal. Connect on
an already-configured provider **is** rotation (validate new → write → audit
`rotate`). `remove` deletes the line (same atomic 0600 rewrite). Keys found in
`env` or in `triage.key_file` show as `source: env|file` and are **read-only in
the UI** — team-up does not edit Hermes' file or the shell's environment.

## 2. Models — read-only join, no second discovery path

`~/.team-up/scores.json` holds 465 models (`scores`, `price`, `provider`,
`openrouter_id`), written by `team-up refresh` (`collectScores` + `writeScores`,
`src/scores/scores.mjs`). The roster knows 15 of them. No second catalogue.

`GET /api/models` returns the **join**, one row per catalogue model:

| field | source |
|---|---|
| `model`, `display_name`, `provider`, `price`, `scores` | `scores.json` |
| `in_roster` | `roster.models[id] != null` |
| `clis`, `tier`, `account`, `reasoning` | `roster.models[id]` when present |
| `reachable` | `accounts[account].enabled` — a model in the roster whose account is off (e.g. `moonshot`) is listed and greyed |
| `proposal` | the row from `unlistedHighScorers({roster, scoresFile})` (`src/scores/propose.mjs:212`) when this model out-scores a role head by `scores.min_delta` |

Query params: `?in_roster=1`, `?q=<substring>`. Cached 1 s like every v1
endpoint; `scores.json` is 272 KB, so the response is paginated at 200 rows.

**Proposing a model into the roster reuses `refresh`/`propose` and stops there.**

| action | endpoint | writes |
|---|---|---|
| refresh the catalogue | `POST /api/refresh` (admin-gated) | `scores.json` only — `collectScores` + `buildRoleScores` + `writeScores` |
| see what would change | `GET /api/models` `proposal` field | nothing |
| apply a chain change | **not exposed** | — |

`apply-scores` / `refresh --apply` call `applyProposals` and rewrite
`roster.roles[*].chain`. Editing chains from the browser is out of scope
(§5), so the dashboard never calls them; the UI prints the exact CLI line
(`team-up apply-scores`) instead. That is how "reuse the existing writer" and
"no chain editing" reconcile: v2 drives the read half of an existing pipeline.

## 3. CLI install

### Detection — `command -v` first, harness registry as enrichment

`harnessStatus` (`src/harness/registry.mjs:120`) cannot answer "is it
installed": `cursor` and `hermes` map to `unsupportedAdapter`, so both return
`{status: "unsupported", installed_version: null}` while both are installed on
this host. Presence therefore comes from `command -v <roster.clis[cli].cmd[0]>`,
and the registry enriches the three CLIs that have an adapter.

`GET /api/clis` returns one row per key of `roster.clis`:
`cli`, `binary`, `present` (bool), `path`, `version` (adapter `version()` where
one exists), `harness` (the `harnessStatus` verdict), `install_available`
(bool), `install_state` (§ below).

Verified on this host 2026-09-23 — note what the enum actually says:

| cli | binary found | installed | newest record | `harnessStatus` |
|---|---|---|---|---|
| claude | `~/.local/bin/claude` | 2.1.267 | 2.1.267 `status:"unverified"` | `failed`, `record_status: "unverified"` |
| codex | `~/.local/bin/codex` | 0.156.1 | 0.150.1 `unverified` | `failed`, `record_version: 0.150.1` |
| opencode | `~/.opencode/bin/opencode` | 1.18.23 | 1.18.15 `unverified` | `failed` |
| cursor | `~/.local/bin/cursor-agent` | 2026.09.18-9a7762b | — | `unsupported` |
| hermes | `~/.local/bin/hermes` | v0.18.2 | — | `unsupported` |

"Installed but unverified" is **not** a status of its own: a record exists whose
verdict is not `verified`, which `harnessStatus` reports as `failed`. `drifted`
requires the newest record to be `verified` and occurs on **none** of these.
Nothing on this host is `verified`. The UI must therefore render `failed` as
"installed, capabilities denied — run `team-up harness verify <cli>`", not as a
broken install, or every row on a healthy host reads red.

### Install commands are hardcoded per CLI

A table in `src/dashboard/installers.mjs`, keyed by roster cli id. The browser
sends **only the cli id**, validated by membership in `Object.keys(roster.clis)`
— the same allowlist shape v1 uses for tmux session names, not a regex. No URL,
command, version or flag ever arrives from the browser.

| cli | bootstrap (fresh machine) | update | risk |
|---|---|---|---|
| claude | `curl -fsSL https://claude.ai/install.sh \| bash` — **assumed** | `claude update` ✅ | network shell script |
| cursor | `curl -fsS https://cursor.com/install \| bash` — **assumed** | `cursor-agent update` ✅ | network shell script |
| opencode | `curl -fsSL https://opencode.ai/install \| bash` — **assumed** | `opencode upgrade` ✅ | network shell script |
| codex | vendor standalone installer — **assumed, and least certain** | `codex update` ✅ | network shell script |
| hermes | none — Benni's fork, no vendor installer | none | **not offered**; row shows "manual" (decided, Benni 2026-09-23) |

✅ = verified from `--help` on this host 2026-09-23.

**Bootstrap resolution (Benni 2026-09-23: he does not remember what he ran).**
The host's layout settles the shape but not the URLs. Every one of the five
binaries resolves to a vendor-managed directory and **none** is an npm global —
`npm ls -g` lists `team-up` itself but no `@anthropic-ai/claude-code`, no
`@openai/codex`:

| cli | `readlink -f` |
|---|---|
| claude | `~/.local/share/claude/versions/2.1.267` |
| codex | `~/.codex/packages/standalone/releases/0.156.1-x86_64-unknown-linux-musl/bin/codex` |
| cursor-agent | `~/.local/share/cursor-agent/versions/2026.09.18-9a7762b/cursor-agent` |
| opencode | `~/.opencode/bin/opencode` |
| hermes | plain file in `~/.local/bin` (Benni's fork) |

So npm is ruled out for all four and each was installed by its vendor's own
native installer. The exact URLs are **not** to be written from memory at
implementation time: fetch each vendor's current documented install command
then, put it in `installers.mjs` with the date it was checked, and verify on a
throwaway machine or container before the button ships. Until that happens the
install button stays behind `--allow-install` and only the ✅ `update` path is
offered — every CLI here can already update itself, which covers the common
case; bootstrap only matters on a fresh box.

Three of the five pipe a network shell script into bash. That is the risky one
and it is why §4 exists: `POST /api/clis/claude/install` is remote code
execution by design, and only the privilege gate makes it acceptable. The UI
shows the exact command before the confirm step — no hidden execution.

### Execution — tmux session as mutex, log file as truth

```
session:  team-up-install-<cli>          # deterministic name == the mutex
command:  sh -c '<installer> 2>&1 | tee <log>; echo $? > <log>.exit'
log:      ~/.team-up/logs/install-<cli>.log
```

- **Second click cannot start a second install.** `tmuxSessionExists`
  (`src/runs/tmux.mjs:41`) on the deterministic name → `409 install already
  running`. The name *is* the lock; no lockfile, no new state file.
- `tmux new-session -d` returns immediately and reports nothing about the
  command's fate, so the `.exit` sentinel is the status, not the pane.
- The **log file** is what `GET /api/clis/:cli/install/log` tails (last 200
  lines + `.exit` when present). v1 tails panes with `capture-pane`; that is
  the wrong tool here because the pane dies with the command and takes the log
  with it. The `tee` file survives.
- Spawn reuses `tmuxArgs` (`src/roster/command.mjs:87`), which injects
  `TEAMUP_WORKER=1`. An installer is not a worker — pass `TEAMUP_WORKER: ""`
  so the filter in `tmuxArgs` drops it.

| `install_state` | condition |
|---|---|
| `idle` | no session, no log |
| `running` | session exists, no `.exit` |
| `succeeded` | `.exit` == `0` |
| `failed` | `.exit` != `0` |
| `interrupted` | no session **and** no `.exit` — half-finished; the log is kept and a retry overwrites it |

A half-finished install is never cleaned up automatically: vendor installers are
idempotent, retry is the recovery, and the stale log stays readable until then.

### Login stays manual

The dashboard can **start** `claude auth`, `codex login`, `cursor-agent login`
(`NO_OPEN_BROWSER=1`), `opencode providers` — all verified subcommands — in the
same tmux session shape, and it can tail the output so the device code or URL is
visible in the browser. It **cannot finish one**: these are interactive OAuth
flows. The UI says so and prints `tmux attach -t team-up-install-<cli>` for the
human. No key input in a web field for class B/C — that is exactly the phishing
shape §5 keeps out.

## 4. Security

v1's blast radius is "can read run prompts". v2's is remote code execution as
Benni on his own server. The gate has to be stronger than a second bearer token.

### Privilege split — confirmation code on the server's terminal

Rejected: a separate admin token file. It is read once by shell and then lives
in the browser for the session — the same failure mode as v1's token, just a
second copy of it. It does not break the chain "leaked token → RCE".

**Decided:** write and exec actions require a code that only appears on the
terminal running `team-up dashboard`.

1. `POST /api/admin/challenge` → server prints
   `dashboard: confirmation code 418-204 (2 min)` to its own stdout, returns
   `{challenge_id, expires_at}`. Code is `crypto.randomInt`, 6 digits, one
   live challenge at a time, 3 attempts.
2. `POST /api/admin/confirm {challenge_id, code}` → on match, mints an
   in-memory capability bound to the caller's cookie, **TTL 10 minutes**,
   dropped on process exit.
3. Every write/exec endpoint requires that capability; without it → `403
   admin confirmation required`, which the UI turns into the code prompt.

This works because it needs shell access *at the moment of the write*, which a
stolen cookie does not have. It costs nothing in the driver scenario: you are at
the terminal during onboarding anyway. Ten minutes covers one onboarding pass
without leaving a standing privilege.

### CSRF

`SameSite=Strict` already blocks the cross-site cookie ride, but a
state-changing POST gets its own check, both cheap and dependency-free:

- Require header `X-Team-Up-CSRF: 1`. A custom header cannot be set
  cross-origin without a CORS preflight, and the server sends **no** CORS
  headers, so the preflight fails and the POST never happens. Presence is
  sufficient; no nonce, no server-side state.
- Require `Origin`, when present, to equal the server's own origin; reject
  otherwise. Absent `Origin` (curl, the `Authorization: Bearer` path) is
  allowed — that path carries no ambient credential and is not CSRF-able.
- Reuse `readBody`'s existing `MAX_BODY = 4096` cap.

### Bind and reverse proxy

**Not planned (Benni 2026-09-23): there is no nginx in front of this.** Default
bind stays `127.0.0.1`, remote access stays `ssh -L 8556:127.0.0.1:8556`, and
that is the whole access story for v2. Consequences, so nobody re-derives them:

- The confirmation code is printed to the terminal running `team-up dashboard`
  and a human is at that terminal. Under systemd it would land in the journal
  and weaken the gate — so v2's dashboard is a foreground command, not a unit.
- The audit `actor` is always `127.0.0.1`. It identifies the host, not a person.
  That is honest for a single-user box; per-user attribution needs a proxy and
  is out of scope.
- `--host` other than loopback keeps printing v1's warning, and v2 additionally
  **refuses** every write/exec endpoint when the bind is not loopback. Read
  views still work.

If a proxy is ever put in front, two v1 defects must be fixed first: the cookie
has no `Secure` flag, and the cookie value *is* the token (no session id, so a
proxy log or a `Set-Cookie` leak is a full credential leak and rotation cannot
invalidate a session). Both are listed as v1 defects, neither is v2's job.

### Audit trail

No append-line logger exists — `debugLog` (`src/debug.mjs`) is `O9K_DEBUG`-gated
and hardcodes `hook-errors.log`. v2 adds `appendAudit()` in
`src/dashboard/audit.mjs`: one JSONL line per event to
`~/.team-up/dashboard-audit.log`, created 0600.

```json
{"ts":"2026-09-23T10:11:12.000Z","actor":"127.0.0.1","action":"provider.connect",
 "target":"openrouter","result":"ok","hint":"…a91f"}
```

Actions: `provider.connect`, `provider.rotate`, `provider.remove`,
`provider.validate`, `cli.install`, `cli.login`, `refresh`, `admin.challenge`,
`admin.confirm` (incl. failures). Never the secret — `hint` is the last four
characters and nothing else. The file passes through `sanitizeForDashboard`
before it is ever served, and it is **not** served in v2 (`tail -f` it).

## 5. Scope boundary

| in v2 | out of v2 |
|---|---|
| connect / validate / rotate / remove `OPENROUTER_API_KEY` | any other API key; an `ANTHROPIC_API_KEY` path (§0) |
| model catalogue listing + proposal display | editing `roster.roles[*].chain`; `apply-scores`; chain drag & drop |
| `POST /api/refresh` (writes `scores.json`) | `refresh --apply` |
| CLI detect + install + start-login | completing a login; any key entry for a class B/C CLI |
| install log tail | web terminal, `send-keys`, arbitrary commands |
| audit log written | audit log browsable in the UI |
| — | starting runs, run cost timeline (unchanged from v1's out-list) |

Each out-of-scope item either widens the RCE surface or needs its own design
pass. v2 is already the version that crosses from read to write; it crosses once.

## Changes by file

| file | change |
|---|---|
| `src/keys.mjs` (new) | `lookupKey({keyName, keyFiles, env, warn})` — body moved out of `triage.mjs`, unchanged semantics (env first, 0600 refusal, never into `process.env`) |
| `src/roster/triage.mjs` | `lookupTriageKey` becomes a wrapper over `lookupKey`; file list `[secrets.env, triage.key_file]` |
| `src/collectors/openrouter-models.mjs`, `-benchmarks.mjs` | default `apiKey` via `lookupKey` instead of `process.env` only |
| `src/json-store.mjs` | `atomicWriteText(path, text, {mode})` — mode set on tmp before rename |
| `src/paths.mjs` | `secretsPath(env)` → `~/.team-up/secrets.env`; `installLogPath(cli, env)` |
| `src/dashboard/providers.mjs` (new) | read/write/remove one `KEY=VALUE` line; validate via `GET /api/v1/key` |
| `src/dashboard/installers.mjs` (new) | hardcoded per-cli bootstrap/update/login table; `detectClis(roster)`; `installState(cli)` |
| `src/dashboard/audit.mjs` (new) | `appendAudit(event)` → JSONL, 0600 |
| `src/dashboard/admin.mjs` (new) | challenge/confirm, in-memory capability, TTL |
| `src/dashboard/server.mjs` | POST routing, CSRF + Origin check, admin gate, loopback gate on write endpoints, new endpoints |
| `src/dashboard/data.mjs` | `buildModelsView(scores, roster, {q, in_roster})`, `buildProvidersView`, `buildClisView` |
| `src/dashboard/public/*` | Setup tab: Providers, Models, CLIs; code prompt; log tail |
| `test/dashboard/providers.test.mjs` | validate 401 → nothing written; 200 → 0600 file; rotate replaces the line; remove deletes it; response never contains the value |
| `test/dashboard/installers.test.mjs` | unknown cli id → 400; second install → 409 via fake `tmuxSessionExists`; `.exit` → succeeded/failed; no session + no exit → interrupted |
| `test/dashboard/server.test.mjs` | POST without `X-Team-Up-CSRF` → 403; foreign `Origin` → 403; write without admin capability → 403; expired capability → 403; write endpoint on non-loopback bind → 403 |

No new npm dependency. `node:http`, plain DOM, existing helpers only.

## Verified vs assumed

**Verified against the code / this host (2026-09-23):** the three-way provider
split and that OpenRouter is team-up's only key (`grep`, `roster.accounts`,
`roster.subscriptions`); collectors read `process.env` only; `atomicWriteText`
takes no mode; `lookupTriageKey`'s env→file order and 0600 refusal;
`unlistedHighScorers` exists and does the proposing; `scores.json` holds 465
models vs the roster's 15; OpenRouter `/api/v1/models` is public (200) while
`/api/v1/key` is not (401); `harnessStatus`'s five-value enum and what each CLI
on this host actually returns; `cursor`/`hermes` are `unsupportedAdapter`;
`tmuxSessionExists`, `tmuxArgs` and its `TEAMUP_WORKER=1` injection; `readBody`'s
4096 cap; `sanitizeForDashboard`'s key filter; `debugLog` is the only appender
and it is debug-gated; the update/login subcommands in the §3 table (`--help`).

**Assumed:** every bootstrap install command in §3 (inferred from on-disk layout
+ vendor docs, never executed here); that `GET /api/v1/key` returns a usable
label/limit body and not just 200; that `claude auth` / `opencode providers` are
the right login entry points rather than `claude setup-token` /
`opencode providers login`; that vendor installers are idempotent on retry.

## Decided (Benni, 2026-09-23)

| # | question | answer |
|---|---|---|
| 1 | bootstrap install commands | He does not remember. npm ruled out by the layout evidence in §3; URLs get fetched from vendor docs at implementation time and verified on a throwaway box. Button stays behind `--allow-install`, `update` path ships. |
| 2 | hermes | Manual. No clone + `pip install -e` from the dashboard: it is his own fork with no installer, and a source build is a different failure surface than four vendor scripts. |
| 3 | key store | `~/.team-up/secrets.env` as §1 argues. `~/.hermes/.env` stays readable and untouched. |
| 4 | admin capability TTL | 10 minutes. |
| 5 | reverse proxy | No nginx planned. §4 shrunk accordingly; loopback + `ssh -L` is the access model. |

Nothing in this spec is open. Implementation can start from it.
