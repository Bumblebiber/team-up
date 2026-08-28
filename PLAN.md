# Plan: the specialist pipeline

Written 2026-08-28. Replaces the completed "fourth runtime review remediation"
plan, which is preserved in git history.

## What this is for

The goal is a pipeline of narrow specialists rather than one agent carrying
every capability. The concrete measure of success is context cost at start:
o9k reached 40k tokens before doing any work, because every skill, plugin and
MCP server was loaded for every task.

## Decisions already settled — do not re-open these

**Context isolation is already solved, and it is not Docker's job.** The
capsule mechanism does it today: `CLAUDE_CONFIG_DIR` pointed at a per-run
home, `--plugin-dir`, `--strict-mcp-config --mcp-config`, `--setting-sources
user`, and the `--tools` allowlist. Measured against run
`20260827T214125Z-z0mu`: 81 skills visible on this host, 2 in the capsule; no
`installed_plugins.json` in the capsule at all (only a marketplace catalogue);
three named MCP servers instead of the host's full set; MCP tools narrowed to
the twelve declared browser tools plus context7's two.

**Docker was measured and is not adopted.** It does enforce `project_readonly`
and `writes` where the systemd sandbox cannot (Ubuntu 24.04 sets
`kernel.apparmor_restrict_unprivileged_userns=1`, so the user manager cannot
build the mount namespace `ProtectHome` needs). But it costs a root daemon, a
maintained image, and a root-equivalent channel per spawn — and it would make
this public repo unrunnable anywhere those are absent. It defends against a
threat model this project has explicitly declined: `docs/command-broker.md`
states the accepted boundary as protecting "normal harness tool use", not
hostile same-UID tampering.

What actually closes the gap is cheaper and already here. The command broker
denies the native shell outright (`--disallowedTools Bash`) and exposes one MCP
tool per pre-approved action ID, with fixed argv arrays, no free-form
arguments, and `spawn(..., { shell: false })` under a sanitized environment.
There is no generic `run` tool to escape through. Write scope is a tool
specifier, not a container — see step 5.

The Docker measurements are kept in TIM P0073/Decisions, entry
`ubun-0828-ns-01M13VRC`, for the day something has to run untrusted
third-party code. That is not this.

**`network: false` cannot mean "no packets".** The claude CLI must reach
api.anthropic.com; under `--network none` or `PrivateNetwork=yes` the agent
never starts. It means "no WebFetch/WebSearch tools", which
`builtinsForPermissions` already implements correctly.

**Revan reviews on the merged result — not inside each Codey.** Per-ticket review cannot see the defect class where two diffs are each
correct alone and broken together. A per-Codey self-check is acceptable as a
cheap pre-filter, but the authoritative pass runs once on the merged state.

**Parallel writers get one full `git clone` per run.** Two writers in one tree
lose an edit silently while both report success — measured with two processes
editing the same line; the second change simply vanished. A `git worktree` is
not a substitute if the worker is ever confined to it, because its `.git` is a
pointer file whose target lies outside; `git clone --shared` has the same
problem through `objects/info/alternates`. A full clone is self-contained —
0.67 s and 13 MB against this repo — and being disposable, the implementer may
use git freely inside it.

## Intended topology

    Benni  ⇄  Overseer      grills · spec · tickets · dispatches · merges · TIM
                 ↓
             Codey × N      one full clone per ticket, in parallel
                 ↓
             Revan          once, on the merged result

**The Overseer is the host session, not a specialist.** It is whatever CLI
Benni happens to start — claude, cursor or opencode, in any working directory —
so it is global configuration (output style, skills, hooks), never a capsule
that gets launched. `grill-me`, `grilling`, `grill-with-docs`, `to-spec` and
`to-tickets` belong to the host and stay installed globally.

**The Overseer is also the orchestrator.** The orchestrator role needed write
access to the real tree and read access to every clone; the host session has
both already. And a merge conflict that needs a decision belongs to the only
agent that can ask Benni.

The obvious objection — a chat session dies, gets compacted, gets interrupted,
and N runs are orphaned — is already answered by the runtime rather than by the
session. `runs.mjs` has `resumeAll`, a resume lock that steals from a dead PID,
and host-crash recovery that reads `STATE.json` instead of re-dispatching. Run
state lives on disk, so the session is replaceable.

One line stays drawn: **orchestrate always, integrate only while it is
trivial.** Dispatch, tracking state and collecting results are bookkeeping. A
real merge conflict with a test run is code work, and that is the moment to hand
it out — not something to build for in advance.

**One repo per specialist**, so a user can take only what they need. Two left to
build: Codey and Revan. Tessa already exists.

## Who writes to TIM

**Only the Overseer. No specialist gets the TIM MCP at all — not read, not
write.** That is already true by accident (`"mcps": []` in both existing
descriptors); this makes it a rule.

The mailbox is already the durable record: every run writes `RESULT.json`,
`STATE.json` and `audit/commands.jsonl` to disk. A specialist that also wrote to
TIM would persist the same thing twice, in a worse shape. TIM is the curated
layer, not the raw one.

Three reasons beyond taste:

- **Parallel Codeys could not do it anyway.** TIM allows one project bind per
  session. Three parallel writers means either a "session already bound" error
  or three sessions writing past each other.
- **Cost.** Roughly 140 `tim_*` tools, handed to a specialist whose whole point
  is being narrow. That is the o9k mistake in miniature.
- **Whoever writes to TIM decides what is remembered as true.** Reanna already
  got a provenance attribution wrong once. In a mailbox report that is an error
  you catch while reading. In TIM it is a false entry someone reads as fact six
  months later.

Context flows in as data, not as a tool: the request schema already has an
`inputs` field, and the Overseer puts the relevant TIM excerpt there. This is
enforceable with what already exists — `--strict-mcp-config` takes only what the
descriptor names, so no `tim` in the descriptor means no TIM in the capsule. No
new code.

**Open risk:** if the Overseer session dies before writing, a result sits in the
mailbox and nobody lifts it. `resumeAll` recovers the run; it does not write the
TIM entry. The current bbbee setup has a Worker-Reaper cron for exactly this and
team-up runs need an equivalent.

## Dropped — the Planner, and the ticket-overlap check

**Paul the Planner is not being built.** A specialist earns its keep for one of
three reasons: it runs in parallel, it needs tooling nobody else needs, or it
needs a different model or CLI. Paul is none of them. Planning is not
parallelisable — there is one plan. `to-spec` and `to-tickets` are skills, so
they cost the Overseer nothing until invoked, and both are installed globally
already; the bundle would repackage what is there.

The grill cannot be delegated in any case. It is a conversation — ask, read,
follow up — and the most valuable part is what Benni corrects between answers.
That does not serialise into an `inputs` field. Whoever grills has the context
for the spec; handing it on means writing the spec twice, the second time worse.

There is one real argument on the other side: the author of a spec cannot judge
whether it stands up without the conversation behind it. That is the same
reasoning that gives Revan a fresh session. But it produces a *test*, not a
process — can a cold reader who sees only the spec cut it into tickets? — and
that test is worth adding the day specs turn out thin, not before.

**The ticket-overlap check is also dropped, and the argument for it was wrong.**
It rested on the measurement where two writers shared one `:rw` mount, the second
write won, and both reported success. That design was discarded. With one full
clone per Codey, overlapping edits surface as a git merge conflict — loud and
blocking, not silent. What git does not catch is semantic overlap: two tickets
touching different files on incompatible assumptions. Revan on the merged result
is what covers that, and that was already the plan.

## Step 1 — Bound the recursion — DONE (`853af68`)

`src/specialists/request.mjs` carries `parent_run` and `depth` (line 45) but
nothing enforces a limit. Nothing spawns nested runs yet, so this is not
currently biting; the cap has to exist before the orchestrator does, because
after that a runaway is unbounded spend.

Enforce in `normalizeRequest`, which is already the validation point: reject a
request whose `depth` exceeds the maximum. Use one constant, and use the same
number as the review-cycle cap so a Codey→Revan→Codey ping-pong is bounded by
the same rule. The existing pipeline uses 3.

Verify with a unit test: a request at the cap normalizes, one past it throws.

## Step 2 — Remove the network mapping that will break Tessa — DONE (`853af68`)

The bug was wider than the paragraph below says. `PrivateNetwork` came from
`Boolean(permissions?.network)`, which is false when the key is merely absent —
so it was not only Tessa's explicit `network: false`. Every specialist that
reached the sandbox for an unrelated reason (`writes: false`,
`filesystem: project_readonly`) lost the network unless it had asked for it, and
that is every consult and every review specialist. Both the isolation trigger
and the `PrivateNetwork` property are gone.

`src/sandbox/systemd.mjs:274` includes `permissions?.network === false` in
`needsIsolation`, and the property list sets
`PrivateNetwork=${network ? "no" : "yes"}`. `testing.tessa@0.1.0` declares
`network: false`. The moment any sandbox actually engages, Tessa stops
starting. Nobody has seen this because the sandbox has never engaged on this
host — the broken sandbox is hiding the bug.

Drop `network === false` as an isolation trigger and stop deriving
`PrivateNetwork` from it. Isolation for the other reasons (filesystem scope,
writes) must still work, and a specialist that needs isolation for those
reasons must still get network.

Verify: a `network: false` specialist produces argv without
`PrivateNetwork=yes`, and `builtinsForPermissions` still withholds WebFetch and
WebSearch for it.

## Step 3 — Deny credential paths to `Read` — DONE (`5ce2bc4`)

Mechanism verified before being built on, since `claude --help` documents
specifier syntax only for the allowlist: `Read(//abs/path)` and
`Read(//abs/dir/**)` both refuse (the leading `//` is the absolute form),
siblings stay readable, and a forced `Grep` on a denied path returns
`is_error: true` — the rule is enforced where the file is opened, not inside the
`Read` tool, so `Grep` does not walk around it. That mattered: a matching line
is where a token would actually surface. Confirmed end to end with the
production rules against a fixture at `~/.aws/credentials`.

Not covered: opencode. Its permission map is tool-name granular and its
path-rule syntax is unverified here, so the gap is documented at the config site
rather than filled with invented syntax.

Decided: close it, do not accept it.

Nothing dramatic happened. Reanna read `~/.claude.json` while scouting, which
was in remit, and that file holds no credentials — 87 KB of config, cache and
telemetry, where every key matching "token" is a token *counter*. The
observation is about reach, not about that read.

What the same unrestricted `Read` also reaches, all mode 600 and all readable
because every specialist runs as the same UID:

    ~/.mcp.json                     IMAP_PASS in cleartext
    ~/.npmrc                        npm token
    ~/.config/gh/hosts.yml          GitHub token
    ~/.hermes/secrets/telegram.env  bot tokens

File modes do not help here — `chmod 600` keeps out other users, not a
specialist running as bbbee.

The realistic failure is not theft but quotation: a specialist reads a
credential file and repeats it in its report, because reporting file contents
is exactly what a scout is for. A RESULT.md carrying a token, committed to a
public repo, is how this actually goes wrong. No malice required.

Add deny-rules via `--disallowedTools` for the credential paths, alongside the
existing `--disallowedTools Bash` the broker already sets. Verify with a run
that tries to read one and is refused.

## Step 4 — Revan — DONE

`~/projects/team-up-with-revan`, `review.revan@0.1.0`, installed and approved
for this project. Local git repo, one commit, **no remote yet** — creating a
public GitHub repo is an outward-facing act and waits for a go-ahead.

`call_types` are `review` and `consult`, deliberately without `delegate`: the
delegate default is `writes: "delegated_only"`, and a reviewer has no business
on that path. `filesystem: project_readonly`, `writes: false`, `network: false`,
`model_profile: frontier/max` — Revan is the authoritative pass in the topology,
so it is the one specialist that should not be cheap.

The bundle carries one skill, `code-review`: the two-axis review (repository
standards, plus the Fowler smell baseline / originating spec) adapted from the
host skill of the same name. The host version spawns two parallel sub-agents;
a capsule specialist holds `Read`, `Glob`, `Grep`, `Write` and no `Task`, so the
bundle version runs both axes in one session and says so.

**semgrep is not in this bundle and should not be.** It is an MCP server, which
means a capability package (`capability inspect` → `install` → `enable --for
review.revan`), not a manifest line. Reanna's scouting stands — MIT, 7 tools,
`SEMGREP_APP_TOKEN` only needed for `semgrep_findings`, and
`write_custom_semgrep_rule` sitting close to a reviewer's anti-remit. Building
that package is a follow-up, and `capabilities/README.md`'s rule applies to it:
never copy a descriptor out of `~/.mcp.json`.

## Step 5 — Codey — DONE, but the write scope is not enforceable

`~/projects/team-up-with-codey`, `coding.codey@0.1.0`, installed and approved
for this project. Local git repo, one commit, no remote — same reason as Revan.

`filesystem: project`, `writes: true`, `network: false`,
`commands: ["project-test"]`, `model_profile: high/medium` — cheaper than the
reviewer on purpose, which is the point of splitting the two roles at all.
Skills: `implementing` and `tdd`.

`diagnosing-bugs` was in the earlier list and is not in the bundle. A bundle
skill is a single `skills/<name>.md` (`manifest.mjs` resolves exactly that
path), and the host version depends on `scripts/hitl-loop.template.sh` plus
sibling files that have no way to travel. `research` was also on that list and
is Reanna's; Codey has `network: false` and could not use it.

Approving Codey needed `.team-up/commands.json` in this project, which did not
exist — `COMMAND_POLICY_MISSING` on the first attempt. It now declares
`project-test` as `["npm", "test"]`, and the approval is checksum-bound to it.
**Every project Codey works in needs its own `.team-up/commands.json`**, or the
approval fails there too. That is per-project setup, not a one-time step.

### The measurement this step was supposed to make — `Write` cannot be scoped

Measured against claude 2.1.250, and the answer is no.

| Channel | Rule | Target | Result |
|---|---|---|---|
| `--allowedTools` | `Write` (bare) | anywhere | written |
| `--allowedTools` | `Write(//abs/dir/**)` | **inside** that dir | **denied** |
| settings.json `permissions.allow` | `Write(//abs/dir/**)` | **inside** that dir | **denied** |
| `--disallowedTools` | `Write(//abs/dir/**)` | inside that dir | **written** |

The settings.json row is the one that carries the argument. In the
`--allowedTools` rows a specifier form may simply never have registered `Write`
as allowed at all, which would make the denial say nothing about matching; the
settings.json channel has no such double duty, and the write inside the granted
path was still refused. The deny row is the second, independent reading: a
`Write(...)` deny rule with a path does not match, where the identical `Read`
rule does. Path rules work for `Read` and not for `Write`.

Untested and not worth testing: an exact absolute file in `//` form on the
allow side. Codey writes files it has not named in advance, so an exact-file
grant could not scope it even if it matched.

So PLAN.md's own fallback applies: **unbounded `Write` plus the prompt**, with
the disposable clone as the actual containment and the OS sandbox where it
engages. No regression against today. Codey's `instructions.md` states the
limit in the second person, because the instruction is now the only thing
holding that line.

One consequence worth naming: the credential deny rules from step 3 protect
reads only. Nothing stops a specialist *overwriting* `~/.ssh/config`. That sits
inside the accepted same-UID boundary in `docs/specialists.md`, but it was not
explicit before.

**The candidate fix, not built here:** a `PreToolUse` hook in the capsule
settings matching `Write|Edit` and rejecting paths outside the run's writable
roots. That is the mechanism the specifier was supposed to be, it costs no
dependency, and it is a change to the launcher rather than to a specialist
bundle — so it belongs to its own step, not to "set up Codey".

## Step 5a — The pipeline skill — DONE

`skills/pipeline/SKILL.md` in this repo. The four existing skills cover the
mechanics of one spawn (`dispatch`), model selection (`roster`), human
capability management (`team-up-manage`) and manual handoff (`pass-to`); none
of them carried the pipeline shape or its invariants, which lived only here.
A fresh Overseer session would re-derive or violate them.

It carries: the six-stage shape, clone-per-writer with the reason a worktree
and `--shared` both fail, review-once-on-the-merged-result, only-the-Overseer-
writes-to-memory, the depth cap, the unenforceable write scope above, and the
mailbox-orphan risk. Mechanics are referenced, not repeated.

Skills are auto-discovered from `skills/`; `plugin.json` lists none
individually, so the directory is the registration.


## Step 6 — Retire o9k

Once the specialists carry what o9k carried, o9k has no reason to exist. Its
skills and plugins are distributed rather than discarded.

### What is actually there

On `main`, five plugins holding ten skills:

| Plugin | Skills | Where it goes |
|---|---|---|
| `o9k-core` | `o9k-guide`, `o9k-init`, `o9k-stats`, `o9k-update`, `using-o9k` | Nowhere — these are *about* o9k and die with it |
| `o9k-dispatch` | `dispatch` | Already handed over; that is what the `chore/hand-dispatch-to-team-up` branch is |
| `o9k-scout` | `scout` | Reanna — repo mapping and search-before-read are a researcher's tools |
| `o9k-recon` | `framework-scout`, `companion-bundles` | Reanna — this is capability scouting, which she already does |
| `o9k-memory` | `memory` | Undecided. TIM is reached through an MCP server, so the skill may be redundant; check before assuming it needs a home |

Caveman is not at risk: it lives at `~/.agents/caveman.md`, is synced into
`~/.claude/output-styles/caveman.md`, and is selected in `settings.json`. It
never depended on o9k, and as an output style it costs a specialist almost
nothing — which is why "everyone gets Caveman" needs no capability work at all.

### Blocker — unmerged work

o9k has five worktrees, and **five** branches hold commits that are not on
`main` — 14 in total:

    feat/tim-o9k-statusline-coexist    8 commits
    feat/scout-sandbox-extract         3 commits
    feature/roster-effort              1 commit
    feature/team-up-adapter            1 commit
    chore/hand-dispatch-to-team-up     1 commit

The Cursor agent (Grok 4.6 Medium) has finished; full report in
`~/projects/tasks/task-o9k-merge/RESULT.md`. Four of the five landed on a local
`main`, now 9 commits ahead of `origin/main` and not pushed. Plugin inventory
went 5 → 7: `o9k-caveman` and `o9k-roster` (with `roster` and `roster-refresh`)
are on `main` for the first time, and `o9k-recon/skills/bundle-bench` is present.

Two things it left for a person.

**`feat/tim-o9k-statusline-coexist` is abandoned** — 8 commits, 1228 lines,
well tested, and solving a problem that no longer exists. They are
`detect-tim`, `strip-tim`, `migrate`, a doctor check for a TIM stray, and an
`o9k-init` A/B/C migration interview: their entire purpose is teaching an o9k
installation to cope with a TIM-owned statusline. The active statusline here is
`tim-statusline.sh`, `o9k-statusline` is not installed globally, and o9k is off
every host as of 2026-08-28 — the migration these lines automate has already
happened by hand. Porting them to `o9k-statusline` makes no sense either: that
package *provides* a statusline, while this code is about o9k *detecting TIM's*.
The branch stays readable in the archived repo.

**One merge was undone by a rule in the spec, not by the code** — since fixed.
The spec said plugin inventory must never shrink, so when
`chore/hand-dispatch-to-team-up` deleted `plugins/o9k-dispatch/`, the agent put
it back (`a7b2713`), an exact revert of the deletion `1cc997d` intended. The
agent followed the spec; the spec was wrong for a branch whose whole purpose is
removal. Reverted in `2900454`; the plugin count is 6 and the dispatch handoff
now reads consistently with the docs and marketplace entries that describe
dispatch as team-up-owned.

Those branches also carry plugins that `main` does not have at all —
`o9k-caveman`, `o9k-roster` with `roster`/`roster-refresh`, and
`o9k-recon/bundle-bench`. Deleting the repo without resolving them loses work
that was never merged. Resolve first: merge, port, or consciously abandon each.

### Global uninstall — DONE (2026-08-28)

o9k is gone from every host on this machine, before the repo itself is touched.
`o9k-uninstall.mjs --run` cleared claude, codex, cursor, opencode and hermes:
skills, cursor rules, session and precompact hooks, the opencode plugin, the
canonical tree at `~/.agents/skills/o9k/`, and the o9k entries inside
`.codex/hooks.json`, `.cursor/hooks.json` and `.hermes/config.yaml`. The six
plugins came out at both scopes (`user` and `project`), then the marketplace, then
the plugin cache. An older generation the uninstaller did not know about went
too: 19 `o9k-*` skills under opencode, `~/.hermes/skills/o9k/`, and two stale
`.bak` files.

Two directories that sat under `~/.hermes/skills/o9k/` but are not about o9k —
`hermes-fork-patches` and `hmem-sync-status-hook` — were moved up one level
rather than deleted.

`~/.claude/skills` went 81 → 68, with no broken symlinks left behind. Everything
removed is backed up at `~/backups/o9k-uninstall-2026-08-28/`.

**o9k shipped no MCP servers.** Nothing to uninstall there: `tim` is declared in
`~/.claude.json`, and playwright, paperclip and imap in `~/.mcp.json`. None
belong to o9k.

`~/.o9k/` was kept: it is user data, not skills — `roster.json`,
`arbitration.json`, usage windows, logs. The roster cron still reads it.

`~/CLAUDE.md` is now stale. It documents the Dispatch Gate, `o9k-dispatch` path
A, `o9k-roster` and the roster pipeline as the primary route, and those point at
nothing. That is Benni's file to rewrite.

### Host cleanup beyond o9k — DONE (2026-08-28)

The clutter was not specialist-owned skills; it was dead ones. Twelve `hmem-*`
skills were installed on claude and twenty-two on opencode, while the hmem MCP
servers already sit in `disabledMcpjsonServers` and the standing rule is that
hmem is a readable archive. They called tools that no longer answer.
`hmem-wipe` — a skill that erases memory, with a dead backend — is the one worth
naming.

Removed from both hosts; sources remain in `~/projects/hmem/skills` and a backup
sits in `~/backups/hmem-skills-uninstall-2026-08-28/`. The 486 MB under
`~/.hmem` is untouched: skills are not the data, and the archive stays readable.

Two were checked and kept. `hmem-sync-status-hook` watches the sync server on
:3100, which still answers 200. `tim-hmem-import-audit` belongs to TIM.

`maimo-playtest` moved into `~/projects/maimo-rpg/.claude/skills/`, where it
travels with the project. That repo's `.git/info/exclude` excluded `/.claude/`
wholesale, and git cannot re-include a path inside an excluded directory, so the
rule is now `/.claude/*` with `!/.claude/skills/`.

`remarkable` and `remarkable-upload` stay global: the Overseer needs them when
Benni wants to show something from his reMarkable.

`~/.claude/skills` is now 55, from 81 before the o9k uninstall.

### Retiring the repo — DONE except npm (2026-08-28)

Local `main` pushed (`6085488..2900454`, 10 commits, 86 files) after scanning
the diff for credential-shaped strings — clean. Every branch that holds content
is on the remote, including the abandoned statusline branch; the two that were
not pushed are zero commits off `main`. Repo archived on GitHub: read-only,
still public, still readable.

`npm deprecate` **failed and is still open**: `npm whoami` returns 401, so the
token in `~/.npmrc` has expired. After `npm login` the command is

    npm deprecate its-over-9k "Retired. Superseded by team-up — https://github.com/Bumblebiber/team-up"

It marks every published version, 1.0.0 through 2.0.1.

TIM P0072 is now `status: archived`, with the full retirement record in its body
and a pointer to P0073.

### Why archive rather than delete

`team-up@2.0.1` is live on npm and the repo is public. Deleting the remote
undoes none of that — npm, forks and caches all survive it — and only breaks
inbound links and your own ability to look something up later. Archiving is
read-only, reversible, and says the true thing: retired, not vanished.

Order matters, because an archived repo cannot be pushed to:

1. Abandon the statusline branch (above) — after archiving there is no push.
2. Push local `main`. Nine commits, including the merges and the `a7b2713`
   revert.
3. `npm deprecate its-over-9k "retired — see github.com/Bumblebiber/team-up"`.
   Not `unpublish`: npm refuses it after 72 hours anyway, and it would break
   anyone who has it installed.
4. Archive on GitHub.
5. Keep the local checkout until Codey and Revan have round-tripped.
6. TIM P0072 to `archived`, pointing at P0073.

### Define what "delete" means

Archiving on GitHub, deleting the remote, and removing the local checkout are
three different acts with different reversibility. The repo is public, so
anything already pushed may be cached elsewhere regardless. This needs Benni's
call before anything is removed, and nothing is removed until steps 4–5 have
round-tripped — a specialist that cannot yet do o9k's job is not a replacement
for it.

Also unhook the 13 skill symlinks under `~/.claude/skills/` that point into
o9k. They are all live today, so removing the repo would break them rather than
leave them stale. (An earlier note in this session called them stale; that was
wrong — `find -xtype l` reports zero broken.)

## Step 7 — A catalogue in this repo

One repo per specialist means discovery has to live somewhere. The main repo
gets a catalogue: browse the available specialists, see what each one costs in
context and what capabilities it wants, and install the ones you need.

Not designed yet. The open questions are where the list of specialists lives
(a file in this repo, or something resolved at runtime), whether installing
means cloning the bundle repo or fetching a release, and how it relates to the
`capabilities/` packages that already exist.

## Open questions for Benni

- **Public repos for Codey and Revan.** Both bundles are local git repos with
  one commit each and no remote. "One repo per specialist" implies public
  GitHub repos, but creating them publishes; that waits for a word.
- **`npm deprecate its-over-9k`** is still blocked on an expired npm token —
  see the retirement section.
- **`tim-hmem-import-audit`** is TIM's own skill, present in
  `tim/packages/tim-skills/skills`, so removing it from the hosts would only
  last until the next sync. The hmem import is finished; whether the skill
  retires is a TIM decision, not a host cleanup.

## Not in scope

Any container runtime, and with it the AppArmor userns question. Write scope
turned out not to be a tool specifier (step 5), so the honest statement is
narrower: the containment that exists is the disposable clone plus the prompt,
and the next lever to try is a `PreToolUse` hook, not a container. Both stay documented in
the TIM entry for the day a specialist has to run untrusted third-party code.

New runtime dependencies generally. team-up should stay runnable with node and
git.
