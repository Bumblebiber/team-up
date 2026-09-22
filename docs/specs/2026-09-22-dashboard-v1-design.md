# team-up dashboard v1 — read-only ops view

Status: draft · 2026-09-22 · owner: team-up (P0073) · depends on: `pick --json` from `2026-09-22-jev-triage-design.md`

## Decision: rebuild inside team-up, don't extend `~/projects/dashboard-web`

Audit of `dashboard-web` (server.js 452 lines, dashboard.js 568, Express):

| finding | consequence |
|---|---|
| Built for Hermes/TIM: TIM task export, Hermes cron pause/resume, hardcoded `TIM_CLI` path | none of its data is team-up data |
| Binds `0.0.0.0`, token accepted via `?token=` query, plain `!==` compare | token leaks into logs/history; timing-unsafe |
| `/api/events` re-runs a full TIM export + `tmux ls` + two external HTTP calls **every 3 s per client** | load scales with open tabs |
| Parses human `tmux ls` output by regex | team-up already has `listTmuxSessions()` (`src/runs/tmux.mjs`, `-F` format) |
| Not running (port 8555 free), legacy per its own CLAUDE.md | no users to migrate |

Reused: only the auth *shape* (token file + rotate command) and, later, the
OpenRouter/DeepSeek balance fetchers (~60 lines) when provider billing lands.
Everything else is dropped. `dashboard-web` stays as is (not deleted by this spec).

## Scope v1 — read-only

1. **Runs** — table of `listAllStates()`: runId, role, status, worker `cli:model`, cwd/project, age, heartbeat age. Filter active / all. Click → PROMPT.md, STATUS, RESULT.md (read-only, rendered as text).
2. **tmux** — sessions from `listTmuxSessions()`, linked to their run via `state.worker.tmux`. Orphans (no run) flagged. Click → last 200 lines via `capture-pane -p` (polled while open, 2 s).
3. **Usage traffic light** — `~/.team-up/usage.json` windows (`claude:session`, `claude:week`, `codex:5h`, `codex:weekly`, `cursor:*` …): used %, resets_at, updated_at. Red ≥ `limits.handoff_at`, amber ≥ `warn_at`. **Stale** badge when `updated_at` is older than the window's expected refresh (surfaces the open P1 "Stale Claude weekly usage blocks roster after reset"). `marked` entries listed with `until`.
4. **Pick preview** — for every role: what `pick` returns right now, plus `skipped[]` with reasons. The most useful debug view: explains *why* a role lands on a given model.

Out of v1 (v2+, each its own spec): chain drag & drop, web terminal / sending keys, provider/API-key management, starting runs, roster-refresh apply, run cost timeline. All of these write or open a shell; v1 proves the read model first.

## Architecture

- `team-up dashboard [--port 8556] [--host 127.0.0.1]` — new subcommand, `node:http` only, **no new dependency** (no Express, no bundler, no framework).
- Server imports team-up modules directly (`listAllStates`, `listTmuxSessions`, `pick`, usage loader). No shelling out to its own CLI, no parsing of its own text output. `pick --json` exists for external callers; the server calls `pick()` itself.
- Endpoints (all GET, JSON):
  - `/api/runs?active=1`
  - `/api/runs/:id` (state + mailbox files, size-capped 256 KB each)
  - `/api/tmux`, `/api/tmux/:session/pane`
  - `/api/usage`
  - `/api/pick` (all roles)
- Frontend: one `index.html` + one `app.js` + one `app.css`, served from `src/dashboard/public/`. Plain DOM, polling (5 s for lists, 2 s for an open pane). No SSE in v1 — polling one small JSON per view is cheaper than the old per-client fan-out and simpler to reason about.
- Caching: each endpoint memoizes for 1 s so N tabs ≠ N× tmux calls.

## Security

- Default bind `127.0.0.1`. Remote access via `ssh -L 8556:127.0.0.1:8556 <server>`. Binding anything else requires `--host` explicitly and prints a warning.
- Token at `~/.team-up/dashboard-token` (0600, generated on first start; `team-up dashboard --rotate-token`). Sent as `Authorization: Bearer` header only — never a query parameter. Browser flow: login form posts the token once, server sets an `HttpOnly; SameSite=Strict` cookie. Compare with `crypto.timingSafeEqual`.
- Input validation at the boundary: `:id` must match the run-id pattern (`safe-id.mjs`), `:session` must be in the current `listTmuxSessions()` result — never passed to tmux otherwise. Mailbox reads resolve inside `runDir(id)` only (no `..`).
- v1 is read-only: no endpoint mutates state, no `send-keys`. Keeps the blast radius of a leaked token to "can read run prompts".
- nginx reverse proxy with TLS is possible later; not part of v1.

## Files

| file | purpose |
|---|---|
| `src/dashboard/server.mjs` | http server, routing, auth, caching |
| `src/dashboard/data.mjs` | pure functions: runs view, tmux↔run join, usage staleness, pick-all |
| `src/dashboard/public/{index.html,app.js,app.css}` | UI |
| `src/cli.mjs` | `dashboard` subcommand |
| `test/dashboard/data.test.mjs` | tmux↔run join incl. orphans; usage stale/red/amber; pick-all with a fake roster |
| `test/dashboard/server.test.mjs` | 401 without token, token in query rejected, invalid run id → 400, unknown session → 404, path traversal rejected |

## UI notes

Dense ops view, dark + light via `prefers-color-scheme`, works at phone width
(Benni checks from mobile). Four tabs or one page with four panels — writer's
choice, but the usage light and active runs must be visible without scrolling
on desktop.

## Acceptance

- `team-up dashboard` starts, prints URL + token path, serves on 127.0.0.1.
- All four views render against the live `~/.team-up` without errors.
- `npm test` green, including the security tests above.
- No new entry in `package.json` dependencies.
