# team-up dashboard — usability for non-technical users

Status: in progress · 2026-10-19 · owner: team-up (P0073) · branch `feat/dashboard-usability`

Benni (creator) on the dashboard: built for techies, should serve people who are
not deep into computer science. Convenience first. Concretely: the Action Center
does not say which project a question belongs to, shows every question in full
and overwhelms; it should work like an e-mail inbox (short subject = project +
the question's quintessence; click opens the full question and the answer box).
Two of today's items are bugs, not questions. "Policy" and "Branch" in Projects
mean nothing to him; `~/projects/tasks` should not be a project. Specialists is
"terribly implemented". He wants German as a UI language, and questions from
team-up agents to the human in that language, while agent-to-agent traffic stays
English.

Research behind this spec (read for detail, file:line evidence):
`/tmp/claude-1000/-home-bbbee-projects-team-up/3debb811-e2ba-4cf0-b0dc-2619b42d4101/scratchpad/reports/`
r0 action center · r1 projects · r2 specialists · r3 i18n · r4 live UI audit
(screenshots in `../ui-before/`) · r5 comparable projects · r6 UX checklist.

## Decisions (defaults; Benni may override)

| # | Decision |
|---|---|
| D1 | One language setting: `roster.json` top-level `"language": "en" \| "de"` (missing = `en`). Agents, scripts and the dashboard all read it there. Dashboard switch reloads the page. |
| D2 | German voice is informal **du**, sentence case, no Title Case. |
| D3 | Text an agent writes **for the human** (the `QUESTIONS.md` block and its `Subject:` line, the observer judge's escalation `question`) follows D1. Everything else (protocol, RESULT.json/RESULT.md, code, commits, agent-to-agent) stays English. Results are not translated in v1. Old questions keep their language. |
| D4 | **Expert view** toggle, per browser (localStorage key outside the synced `teamup.*` namespace), default **off**. Off hides technical views and technical detail (see "Navigation"). |
| D5 | Inbox kinds: **question** (a worker asks), **problem** (a run got stuck on something technical or failed — never presented as a question), **result** (finished work not read yet). `waiting_decision` leaves the inbox (nothing writes it; it is a capacity park). Automation runs (`role` starting `cron-`) never enter the inbox. |
| D6 | `~/projects/tasks` is hidden from Projects now. Moving the clone root to `~/.team-up/clones` waits for Benni's go (not in this branch). |
| D7 | No new dependencies, no build step. Vanilla JS, `node:http`. |

## Glossary (one term per concept)

| Concept (code) | EN UI | DE UI |
|---|---|---|
| Action Center view | Inbox | Posteingang |
| waiting_human run, worker-sourced | Question | Rückfrage |
| observer escalation / failed run | Problem | Problem |
| uncollected done run | Result | Ergebnis |
| run | Task run (avoid "run" in simple view: "work", "job") | Auftrag |
| specialist | Specialist / team member | Spezialist |
| specialists view | Team | Team |
| role | Role | Rolle |
| scheduled job | Scheduled job | Geplante Aufgabe |
| expert view | Expert view | Expertenansicht |
| collect (mark read) | Mark as read | Als gelesen markieren |
| answer | Send answer | Antwort senden |
| parked spender run | continues tonight from 23:00 | geht heute Nacht ab 23:00 weiter |

Never translate: CLI names, model ids, `cli:model`, role ids, run/TIM ids, paths,
mailbox file names, status enum values in prompts, commands, cron expressions,
env keys, settings paths, Telegram footer markers 📂 🤖 🧵, endonyms
("English", "Deutsch"), agent-written content.

## 1. Run → project (server)

A run must resolve to its real project even though it runs in a clone.

At **create time** (new runs):
- `scripts/usage-spender.py` passes `--project <label>` from the repo's
  `.tim-project` (it already reads it in `local_repos`), falling back to the repo
  basename; also pass the human task title if `runs create` gains a flag for it
  (`--title`, stored as `state.title`, optional).
- `scripts/ops-run.sh` passes `--project` from the cwd's `.tim-project` when there is one.
- `createRun` with no `project`: walk up from `cwd` for `.tim-project`; else
  leave null (read-time resolution covers it).

At **read time** (`action-center.mjs`, also used by the runs table "Project"
column): label → absolute path matched against `projectDirs()` (every
`.tim-project` marker in the collecting folder, not only projects with open
items) → `cwd` prefix against `projectDirs()` → clone `origin` remote (local
path maps directly; GitHub URL matched against the origins of the collecting
folder's repos; cached per cwd) → spender ledger
(`~/.team-up/reports/usage-spender/ledger.json`, keyed by `run_id`) → cwd
basename. Display name = repo directory basename (e.g. `tim`, `ultratodo`).

Acceptance on today's live data: 14uh, 1b8p → tim (P0063); 34tq →
SpaceColosseum (P0065); li88 → team-up (P0073); yrjt → ultratodo (P0079);
71ef (cron-golden-task) → not in the inbox.

## 2. Inbox (server)

`GET /api/action-center?dir=` returns a flat, sorted `items[]` plus `counts`:

```
{ id, runId, kind: "question"|"problem"|"result",
  project: { label, name } | null,
  subject,            // one line, ≤ 90 chars, see below
  ageMs, worker, role,
  status,             // run status
  parked,             // spender run with no live worker: answer resumes it in the next window
  resumeWindow,       // e.g. { start: 23, end: 3 } when parked
  source }            // "worker" | "observer"
```

Sort: question, then problem, then result; newest first inside a kind.
`counts = { question, problem, result }`.

`GET /api/action-center/item/:runId` returns the detail: `subject`, `body`
(the full latest question block, **not truncated**; markdown), `source`,
`history` (earlier question/answer pairs if any), `task` (one-paragraph excerpt
of the task from PROMPT.md, after the protocol header), and for results
`result` (RESULT.json summary and/or RESULT.md, capped generously, e.g. 64 KB).

Subject chain: a `Subject:` first line of the block → first markdown heading,
stripped of `Frage:` / `Question:` / `Decision needed:` prefixes → `state.title`
→ spender ledger title → first sentence (≤ 90 chars). Problems get a plain
subject from the server (e.g. "Stuck on a technical prompt", "Failed: <reason
line>").

Kinds:
- `waiting_human` + last block source worker → question.
- `waiting_human` + last block `<!-- source: observer -->` → problem.
- `failed` + uncollected (≤ 7 days), non-cron → problem; detail shows the reason from RESULT.
- `done` + uncollected (≤ 7 days), non-cron → result.

Actions: answer (question), retry / cancel (problem; read `observe.mjs` and the
spender resume path to define what "retry" does for a parked vs a live run, and
make it correct), mark as read (result, problem). **Merged / Discarded also set
`collected`.** Answering is idempotent (second send on an answered item →
"already answered").

## 3. Observer (root cause of the trust "question")

- `claudeTrustPromptKeys` (`src/runs/observe.mjs`): join the hard-wrapped lines
  between "Accessing workspace:" and the next blank line before comparing with
  `cwd`. Add a fixture with a path longer than 80 chars (and the variant that
  lists pre-approved commands from `.claude/settings.local.json`).
- A workspace-trust dialog for the run's own cwd is never escalated to the
  human: answer it; if it cannot be matched, the run fails with a technical
  reason (a problem), not a question.
- Judge prompt: the escalation `question` is written in the D1 language for a
  non-technical reader.

## 4. Cron / automation runs

- `scripts/ops-run.sh` collects the run on every terminal status (not only
  `done`) and prints RESULT.md on failure too, so the Telegram report carries the reason.
- The built-in job card in Scheduled jobs shows the last run's outcome
  (ok / failed + reason line) for jobs that run through ops-run (`role` `cron-<job>`).

## 5. i18n

- `roster.json` `language`; Settings row in a new first group "General" (enum
  English/Deutsch, endonym labels); small EN/DE switch in the sidebar header.
- Server replaces `<html lang="en">` in index.html with the roster language;
  the client reads `document.documentElement.lang` at boot.
- `src/dashboard/public/i18n.js` (classic script, loaded before app.js; add it to
  the static whitelist): `LANG`, `t(en, vars)` with `{name}` placeholders and
  English-as-key fallback, `tp(n, {one, other})` via `Intl.PluralRules`,
  `fmtAgo(ms)` via `Intl.RelativeTimeFormat`, date/time via `Intl.DateTimeFormat(LANG)`.
  Ambiguous keys get a context suffix (`"Open|verb"`).
- Static HTML: translated once at boot by walking text nodes and
  `placeholder`/`title`/`aria-label` attributes (exact trimmed match against
  the dictionary). Elements with `translate="no"` / `data-no-i18n` are skipped
  (agent content, names, ids).
- Server registry prose (settings, automation, communication, cron-schedule,
  action-center subjects for problems) through `src/dashboard/i18n.mjs`
  `t(lang, en, vars)`; memo caches invalidated on language change.
- Never build sentences from fragments, never change case of / append to a
  translated string; whole sentences with placeholders.
- Completeness test: every literal `t("…")` in app.js and server modules, and
  every static index.html text, has a DE entry or is on a short allowlist.
- Agent side: `templates/worker-prompt.md` and `worker-prompt-legacy.md` get a
  `{{HUMAN_LANGUAGE}}` line after the "answered cold" sentence, filled in
  `wrapPromptWithMailboxProtocol` (empty for `en`) **and** appended in the
  `promptHasMailboxProtocol` branch. The line also requires each QUESTIONS.md
  block to start with `Subject: <≤ 70 chars, plain language, no file names or
  ids>`. Text for `de`:
  > Write QUESTIONS.md for the human in German (Deutsch, informal "du"), starting with one line `Subject: …` (≤ 70 characters, plain language, no file names or ids). Everything else you write — RESULT.json, RESULT.md, code, commits, notes for the parent — stays in English. Keep commands, paths, identifiers and quoted output verbatim.
  For `en` only the Subject requirement is added.
- `scripts/telegram.py`: user-facing strings from a 2-language dict keyed by
  the roster language; keep the 📂 🤖 🧵 markers and `FOOT_RE` structure.

## 6. Inbox UI (`#/actions`)

- Nav label "Inbox"/"Posteingang". Badge = questions + problems (red); results
  do not count in red.
- Desktop: list (left, ~40%) + detail (right). Mobile (< 760px): list, then
  full-screen detail with a back button. Selected item in the hash
  (`#/actions/<runId>`); back/reload keep the place.
- Row: kind marker (dot + text label, never colour alone) · project name ·
  relative age; subject (max 2 lines). No role/model in simple view.
- Filter chips: All · Questions · Problems · Results, with counts. Project
  filter select when > 1 project. Filter state is per-browser, not synced.
- Detail: project · who asked (plain: "Implementer (Claude Sonnet)" in expert,
  "A helper" style in simple is fine) · asked N ago; subject as heading; body
  rendered with a small **safe** markdown renderer (escape first, then
  headings, bold/italic, inline code, code blocks, lists, tables, hr; no raw
  HTML, no images; links only http(s) with rel=noopener); "What the helper was
  doing" collapsible with the task excerpt.
- Answer box: label, draft persisted per runId (localStorage, not synced),
  Ctrl/Cmd+Enter sends, button "Send answer" → "Sending…" (disabled) → toast
  "Answer sent — continues tonight from 23:00" (parked) or "— the helper
  continues now". On error the text stays. A "Go with the recommendation"
  chip appears when the body contains a recommendation; it fills the box with a
  short sentence in the UI language (the human still presses Send).
- The 5 s poll re-renders the list only; the detail re-renders only when the
  selected item's content changed, and never rebuilds the textarea while it
  has focus or text.
- Problem detail: plain explanation ("The helper got stuck on a technical
  prompt and could not continue."), the raw text under "Technical details",
  actions Retry / Cancel task (Cancel confirms with a `<dialog>`).
- Result detail: summary rendered; primary "Mark as read"; "Kept" /
  "Discarded" only in expert view, behind a "More" menu.
- Empty states: "Nothing is waiting for you." / filter-empty with "Show all".

## 7. Projects (`#/projects`)

- Default columns: Project (name) · Waiting for you (question/problem count,
  links to the inbox filtered by project) · Working now (active run count) ·
  action "Open session…" (dialog: CLI select defaulting to the last used,
  persisted per browser; then start).
- Hidden by default, under a collapsed "Other folders (n)": the clone root(s),
  non-git folders, `team-up-with-*` bundles.
- Expert view adds: Branch (only a chip when not on main/master: "side branch
  <x>"), uncommitted-changes chip, and "Test command" (the former Policy) with a
  plain explanation and its existing create/edit/trust actions.
- "Fix all" and "auto-fix" are removed (auto-fix writes untrusted policies,
  which turns a working specialist launch into a refused one).
- The collecting folder input moves to Settings → General.
- "+ New project" opens a small dialog.
- Fix: the Sessions prefix match (`projects.mjs` `startsWith`) must compare the
  exact `projectSessionName(name, cli)`, or that name plus `-<entry id>` (a TIM
  task session started from the TIM panel).
- Counts owner: the §7 front end derives "Waiting for you" and "Working now" by
  joining `/api/action-center` `items[].project.name` and the runs list's
  resolved project to the row's `name`, once §1 lands. `/api/projects` gets no
  count fields.

## 8. Team (`#/specialists`)

- Card grid of all specialists: initial avatar coloured by category (id prefix
  coding/testing/review/research/marketing → Developer/Tester/Reviewer/
  Researcher/Marketing), name, one-line purpose (`remit[0]`, capitalised),
  "Works with: <model label>" (`specialist.model` from `/api/specialists`: the
  model a launch would get now, with the launcher's requirements such as
  context isolation; not the Roles row's `pick.label`, which can differ),
  plain permission badges ("Edits
  code", "Read-only", "Uses the internet", "Runs tests", "Up to N min"), status
  (Active / Off when unassigned or error).
- Card click → detail: "Good at" (remit), "Won't do" (anti_remit), built-in
  skills vs added extras (explicit Add / Remove, remove confirms or offers
  undo; the ✕ ambiguity — exclude vs remove target — is explained in words),
  Model section (role select with one-line hint + Save button, or "custom
  model list" → existing chain editor), "Technical details" (expert: version,
  checksum, call types, timeout, exclusions, installed versions).
- Server: `/api/specialists` adds the current model label per specialist
  (`resolveProfile`), and the latest run (status, project, age) by role
  `specialist:<id>` incl. old ids (`testing.hannes` → tessa, `research.hugo` → reanna).
- "Add a specialist" (install from GitHub) in a dialog with a plain
  explanation that installing grants the listed permissions.
- Roles & Models shows "Used by: <name>" per role (`usedBy: [{id, name}]`;
  `name` comes from an installed manifest, so render it escaped).

## 9. Navigation, overview, hygiene

- Simple view nav: Overview · Inbox · Projects · Team · TIM memory · Scheduled
  jobs · Communication · Settings. Expert adds: Sessions & runs, Roles & models,
  Providers, CLIs, AI Trending. Expert toggle in Settings → General and at the
  sidebar bottom.
- Overview tiles and the attention list link to the inbox, not `#/runs`.
- Saved panel prefs bug: `applyPanelPrefs` builds `#<id> [data-…]` for a panel
  without an id (`section.panel.comm-how`), one invalid selector kills the
  whole rule → skip panels without id.
- Filter/tab choices (`teamup.acFilter`, `teamup.timView`, tab keys) are not
  synced across devices.
- Unicode glyph icons get `aria-hidden` (already) and every icon-only button an
  `aria-label`; tabs get `aria-selected`.

## Out of scope (follow-ups)

- Moving the clone root (D6) and retiring the legacy Hermes `CLAUDE.md`/`AGENTS.md`
  symlinks in `~/projects/tasks`.
- golden-task preflight (`.tim-ignore` untracked, baseline drift) — `~/projects/golden-task`, `~/.hermes/cron-prompts/golden-task.md`.
- `~/.hermes/scripts/harness-health.sh` calls the removed `harness reverify`.
- SpaceColosseum commits a Windows `.claude/settings.local.json`.
- Spender clones under `~/.team-up/spender/clones` are never cleaned (5.5 GB).
- Translating RESULT summaries; snooze; Telegram deep links to inbox items.
