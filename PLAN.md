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

`review.revan@0.1.1`, installed, pinned and approved for this project.
Published at
[github.com/Bumblebiber/team-up-with-revan](https://github.com/Bumblebiber/team-up-with-revan)
— public, with a README covering what it does, how to install it and what it
may touch.

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

**semgrep is not in this bundle, and the follow-up is now closed: do not build
the package.** It would have been a capability package rather than a manifest
line, so the first step was to ask the server what it actually exposes instead
of trusting the scouting note. Measured against `semgrep-mcp` 0.9.0 on
2026-08-29, `tools/list` returns exactly one tool:

    deprecation_notice

Its own description names the seven tools it replaces — `semgrep_scan`,
`semgrep_scan_remote`, `semgrep_scan_with_custom_rule`, `semgrep_findings`,
`semgrep_rule_schema`, `get_supported_languages`, `get_abstract_syntax_tree` —
and says to call the notice instead of any of them. Reanna's scouting was
accurate when it was made and is now stale; both `uvx semgrep-mcp` and the
hosted `mcp.semgrep.ai` are deprecated. A capability package built on it would
deliver one tool that tells the reviewer to stop using it.

Two things measured on the way there, worth keeping if a successor server
appears:

- The server needs the `semgrep` binary reachable and does not get it from its
  own `uvx` environment — it fails with `Semgrep is not installed or not in
  your PATH` unless `--semgrep-path` is passed explicitly. That is a runtime
  dependency beyond node and git, which "Not in scope" rules out.
- It initialises Datadog tracing at startup, unprompted, and prints the trace
  URL. For a package whose whole job is reading someone else's code, that is a
  property to decide about deliberately rather than discover later.

`capabilities/README.md`'s rule would still have applied: never copy a
descriptor out of `~/.mcp.json`.

## Step 5 — Codey — DONE, but the write scope is not enforceable

`coding.codey@0.1.1`, installed, pinned and approved for this project.
Published at
[github.com/Bumblebiber/team-up-with-codey](https://github.com/Bumblebiber/team-up-with-codey)
— public. Its README states the unbounded `Write` before the install commands,
because that is what a reader deciding whether to run it needs first.

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

### Three things checked after the fact, because "installed" is not "works"

**The harness record is keyed by CLI version, and this host had drifted.**
Command mediation is enabled only when a stored harness verification record
declares `command_broker` (`adapters.mjs`). Records live at
`~/.team-up/harness-verification/claude/<cli_version>.json`, and the newest was
`2.1.247` against an installed CLI of `2.1.250` — so Codey's non-empty
`permissions.commands` would have hit the pre-broker gate at launch, after
approval had already succeeded. Approval only checks that the policy file
exists and checksums it; it exercises nothing about the broker.

Re-ran `team-up harness verify claude --fixture-project
test/fixtures/harness-project`: native_shell denied, broker_tool passed,
context_isolation passed, `2.1.250` verified. **This has to be re-run after
every CLI upgrade**, or command allowlists silently stop being enforceable.

(The malformed `Code).json` record from an old bad invocation is still in that
directory. It is inert — nothing matches a `cli_version` of `Code)` — but it
should be deleted at some point.)

**The plugin is installed as a copy, pinned by version.** The host resolves
`team-up` from `~/.claude/plugins/cache/team-up/team-up/<version>/`, not from
this working tree, even though the marketplace source is the directory itself.
A new skill directory is therefore invisible until the plugin version moves —
`plugin update` on an unchanged version is a no-op. Hence the 0.1.0 → 0.2.0
bump, and a `plugin update` at **both** scopes: the entry for `/home/bbbee`
(project) and the global one (user) update separately, and updating one leaves
the other pinned. A restart is needed before a running session sees it.

**Nothing runs the eval suites.** `eval_suite` is a required manifest key,
`manifest.mjs` checks the file exists and `materialize.mjs` copies it into the
capsule — no runner consumes the cases. Both new suites match Tessa's shape and
say what the specialists should refuse, but they are a declaration today, not a
test. Worth knowing before treating a passing install as a passing suite.

**Reinstalling the same version with different content leaves an orphan.**
Adding the README changed each package checksum. Installing again at `0.1.0`
created a second checksum tree, but the index selection stayed on the first —
by design, since install never repoints a selection. `uninstall <id>@0.1.0`
then removed only the *selected* tree and could not see the other, leaving an
unreferenced package directory on disk. Removed by hand after checking no
index, pin or approval named it. The clean route, taken here, is to move the
version: both bundles are `0.1.1`, installed, pinned and approved.

**`project-test` reaches a shell transitively.** The policy validator forbids a
shell as the action's executable, and `["npm", "test"]` satisfies that — but
this project's `npm test` ends in `bash test/runs/wait-mailbox.test.sh`. "The
broker closes the shell" is weaker here than it sounds: it closes the *native
tool*, not everything a granted action can reach. That is inside the accepted
same-UID boundary, but it should not be implied otherwise.

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

`npm deprecate` **done (2026-08-29)**. All 28 versions, 1.0.0 through 2.0.1,
now carry:

    Retired. Superseded by team-up — https://github.com/Bumblebiber/team-up

It took three attempts to get there, and the failures were each a different
thing. The token in `~/.npmrc` had expired, so `npm whoami` returned 401. A web
`npm login` fixed authentication but not authorization: the account runs
`two-factor auth: auth-and-writes`, and deprecation counts as a publish-class
write, so it returned 403 asking for an OTP or a token with 2FA bypass. The
login also overwrote `~/.npmrc` — worth remembering before suggesting it, since
token values cannot be read back after creation.

It marks every published version, 1.0.0 through 2.0.1.

TIM P0072 is now `status: archived`, with the full retirement record in its body
and a pointer to P0073.

### Why archive rather than delete

`its-over-9k@2.0.1` is live on npm and the repo is public. Deleting the remote
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

## Found while cleaning up — three things that are not o9k's fault

### The reaper is installed and has never run — FIXED (2026-08-28)

`team-up-gc.service` is a systemd user unit with a five-minute timer. It ran
`team-up.mjs runs gc` and failed every single time:

    usage: runs.mjs <create|classify|answer|set-status|...>

There was no `gc` subcommand on `refactor/reanna`. There is one on `main`:
`src/runs/gc.mjs`, `src/runs/gc-timer.mjs` and two test files, landed in
`830ca1f` on 2026-07-28.

The unit was never broken — the checkout was. It points at
`~/projects/team-up/bin/team-up.mjs`, so whichever branch is checked out
decides whether the reaper exists at all. That is why a worker survived 25
hours after finishing.

Now: `runs gc` exits 0 and `systemctl --user show team-up-gc.service
-p ExecMainStatus` reports 0 for the first time.

### The branch divergence — RESOLVED by replay, not by merge (2026-08-28)

`refactor/reanna` was 62 ahead, 101 behind `main`. Critically, **local `main`
itself was 101 commits ahead of `origin/main` and had never been pushed** — so
`refactor/reanna`, cut from `origin/main`, could not see any of it.

A merge was attempted and abandoned. The reason matters:

- 38 files conflicted, ~130 hunks.
- `src/capabilities/*` was "new" on **both** sides — 12 source and 10 test
  files, written twice.
- The commit titles were identical (`feat: validate capability package
  manifests`, and ten more), but `git cherry` found no patch equivalence.
- Chronology explained it: main's capability work is dated 2026-07-26,
  `refactor/reanna`'s 2026-08-14. The branch re-implemented, from the same
  spec, work it could not see, 18 days later — and so missed the five
  hardening commits main added on top (context-isolation v1, close-world
  manifests, fail-closed content binding, adapter deny, live canaries), along
  with `content-manifest.mjs`, `mcp-schema.mjs`, `isolation-canary.mjs` and
  `canary-mcp-server.mjs`.

Merging two independent implementations of one subsystem by hand is the
likeliest way to silently drop one of main's fail-closed guards. So instead:
branch from `main`, replay only what is genuinely unique.

`refactor/reanna-2` = `main` + 31 replayed commits. The old branch was deleted
locally and on the remote on 2026-08-29, at `60197ae`. Five files lived only
there — `src/harness/isolation-probe.mjs` and its test, the
`test/helpers/verified-harness.mjs` helper, `test/sandbox/launch-env.test.mjs`
and `test/supervisor/descriptor-tools.test.mjs` — every one of them belonging to
a design main supersedes. Of the original 62:

- **13 dropped** as the superseded re-implementation of the capability pool.
- **4 dropped** as superseded by main's better mechanism: the live isolation
  probe (`d9b5d44`, `594a8d6` — main's canaries are more developed), and the
  descriptor/env work (`27bd055`, `77ff0ea` — main has `injectAdapterEnv` and
  a full launch-descriptor system).
- **~14 doc-only PLAN.md commits collapsed** into the final state.
- The rest replayed, with conflicts resolved toward main's mechanism.

Five things were ported by hand rather than cherry-picked, because the commit
that carried them was built on a design main does not use:

1. **Onboarding seeding.** main's `materializeClaudeAuthHome` is stricter than
   the branch's `bridgeClaudeAuth` (atomic staging, closed-world check,
   checksum) but writes no `.claude.json`, so an interactive capsule launch
   stalls in the first-run wizard. The markers now go into main's function.
2. **`workspaceDirs` in the launch record.** `buildCapsuleLaunchRecord`
   carried every directory the worker reads but not the ones it opens, so a
   successor or resume rebuilt a capsule with no workspace trust.
3. **The multi-server tool-list guard.** main's `collectCapsuleMcpTools`
   handed a descriptor's flat `tools` list to *every* server it declared —
   each got the others' tool names. It also existed twice, byte-identical, in
   `launcher.mjs` and `isolation-canary.mjs`, so the canary shared the bug it
   was meant to catch. One definition now, in `capsule.mjs`.
4. **`allowedBuiltins` on the descriptor path.** `prepareArgvFromDescriptor`
   rebuilds the argv that actually runs and never passed the permission-derived
   builtins, so the adapter default applied: a `writes: false` specialist was
   handed `Edit` and `Write` on every real launch.
5. **The relative mailbox path.** main introduced
   `` `mailbox/VERIFICATION.json` `` in both worker templates — the exact bug
   `test/runs/worker-prompt-paths.test.mjs` was written to prevent.

One deliberate weakening, recorded because it is a security check:
`verifyProbeHomeClosedWorld` treated any `.claude.json` in the capsule home as
a violation, because that file is how a leaked global home arrives carrying
user-global MCP servers. It is now judged by content — every key outside the
onboarding markers is still a violation, per-project entries included, and the
negative control's `mcpServers.global` is still caught. Existence alone was a
proxy for "leaked"; the capsule now writes one legitimately.

**Local `main` was still not pushed.** Publishing 101 unreviewed commits to a
public repo is a separate decision from fixing this branch.

Result: 611/612. The one failure, `dispatch --run-id uses run cwd`, fails on
`main` too. Four of main's five baseline failures are fixed by the replay.

### The reaper worked, and immediately looped

Surfaced the moment `runs gc` started running: it reported `kill_terminal` for
eight July runs on every single invocation and never cleared them. The
five-minute timer would have done that forever.

`inspectTmuxSession` only treated a thrown error as absence. Measured on this
host:

    tmux display-message -p -t <dead-session>   → exit 0, prints nothing
    tmux has-session      -t <dead-session>     → exit 1, "can't find session"

So a session that no longer exists came back as `exists: true` with a null
activity time. `evaluateGcAction` then chose `kill_terminal`, `tmux
kill-session` failed because there was nothing to kill, and the run was never
marked cleaned — back again five minutes later.

The same wrong answer defeated the `if (!tmux.exists) return skip` shortcut for
active runs, so staleness was being decided against a session that was not
there.

Treating empty output as absence fixes every caller at once. After it, all 119
runs resolve to `skip`.

This is the second-order cost of a broken reaper: the bug was there the whole
time and could not show itself while nothing ran.

### Codey has never been able to launch — and why the fix is not the tier

Found by dry-running all four specialists after the replay. Three prepare
cleanly; `coding.codey` did not, and never could.

The obvious reading was wrong. Codey asks for tier `high`, and the roster lists
four `high` models, so the tier was not empty. The full skip list says what is:

    codex:gpt-5.6-terra      context isolation unavailable
    cursor:grok-4.5-high     context isolation unavailable
    opencode:grok-4.5-high   context isolation unavailable
    hermes:grok-4.5-high     context isolation unavailable
    cursor:gpt-5.6-luna-max  context isolation unavailable
    opencode:ox-alpha        context isolation unavailable

Every `high` cell runs on cursor, codex, opencode or hermes. **On this host only
`claude` has a usable `team-up.context-isolation/v1` record**, so `high` is
empty in practice — and so is every non-Claude cell at every other tier.

Harness verification is keyed by CLI version, and the CLIs have moved:

| adapter  | record for | installed          |
|----------|-----------|---------------------|
| codex    | 0.145.0   | 0.150.1             |
| opencode | 1.18.15   | 1.18.23             |
| cursor   | —         | 2026.08.25          |
| hermes   | —         | —                   |

Re-running the one supported path, `team-up harness verify codex`, produced
`status: unverified`, `context_isolation: null` on 0.150.1. So codex is not a
stale record to refresh — the current version fails the isolation probe. And
`harness verify` accepts only `claude` and `codex`: **opencode, cursor and
hermes have no verification path in the tooling at all**, so their cells cannot
be reached no matter what a manifest asks for.

That is the real gap, and it is a feature, not a configuration change: live
verify runners for the other three adapters.

For now Codey is made launchable by a host-scoped roster override, which
`resolveProfile` already supports and which needs no version bump, no
republish and no re-approval:

```json
"specialists": { "coding.codey": { "model_profile": { "tier": "frontier", "reasoning": "medium" } } }
```

It resolves to `claude claude-opus medium`.

Getting there took two passes, and the second one matters more than the first.
Benni first asked for work-horse class and named `gpt-5.6-luna-max`,
`composer-2.5`, `deepseek-v4-pro` and `deepseek-v4-flash` — none of which is
reachable, for the reason above. The override went to `medium`, which is where
two of those models sit in this roster, and that resolved to `claude-sonnet`.

Benni's correction: **never Sonnet for coding work** — "ineffizient hoch zehn"
— Opus at medium effort instead. So the reachable-cell question and the
model-quality question have different answers, and the tier that satisfies the
second is `frontier`, the tier Sonnet is not in. Reasoning stays `medium`:
effort is the lever, not the model.

The override is host-scoped, and the published manifest still says
`high`/`medium`. Anyone installing `coding.codey` from GitHub gets a profile
that cannot launch. Correcting that is a version bump, reinstall, re-pin,
re-approve and a push to a public repo — offered, not done.

`research.reanna` resolves to `claude-sonnet low` from its own manifest
(`medium`/`low`). Left alone: the objection was scoped to coding work, and
Reanna researches. Revan and Tessa both resolve to `claude-opus max`.

`research.reanna` also failed its dry run with `NOT_APPROVED` — the stale 0.1.0
approval `doctor` reports. Re-approving is a permission grant, left for Benni.

### cursor cannot be verified yet, and the reason is not what it looked like

Benni asked for cursor (opencode and hermes have no credit right now). The
finding is in `docs/harness-cursor.md`; the summary is that **cursor isolates
correctly and cannot prove it**.

The missing piece was never the verify runner — `registry.mjs` has
`cursor: unsupportedAdapter("cursor")`, so the adapter itself does not exist.
Building one turned out to be gated on something measurable, and the
measurement came out negative.

Isolation works: overriding `HOME` hides `~/.cursor` (MCP, rules, hooks) but
breaks auth, because credentials live under `~/.config/cursor/auth.json` and
follow `XDG_CONFIG_HOME`. Bridging just that one file into an isolated `HOME`
gives both — logged in, global MCP invisible. Same shape as
`materializeClaudeAuthHome`.

The blocker is the proof. `decideContextIsolationCapability` needs a complete
`absent` list covering six planted canaries, and every path to it reads
`init.tools` from a structured init event. cursor's init carries `apiKeySource`,
`cwd`, `session_id`, `model` and `permissionMode` — no inventory. It does emit
typed `tool_call` frames, which prove presence, but a canary that is never
called produces no frame, and absence is exactly what the six canaries test.
Asking the model to self-report is what main's hardening explicitly refuses.

So granting the token would mean either cursor exposing an inventory, or the
contract accepting a second proof shape. The second is a change to a security
check and belongs in a design record, not slipped into an adapter.

Separately: Codey requires `command_broker` too, so isolation alone would not
have unblocked it. cursor's binary contains `beforeShellExecution`,
`beforeMCPExecution` and `preToolUse` hook names, so shell denial looks
plausible — unproven, and the next cheap measurement.

### All three research capabilities pointed at code their checksum did not cover

Found by dry-running Reanna: she could not start at all, failing at capsule
build with `MCP_RUNTIME_COMMAND_DENIED: playwright command must be the node
binary`.

**This is a latent defect the replay exposed, not one it introduced.** Main's
`isAllowedImmutableRuntimeCommand` requires an MCP server's command to be the
node binary, and args that look like paths to be absolute, regular, non-symlink
files, which are then copied into the capsule and set read-only. Held against
that rule, all three packages were wrong in the same way — a content-addressed
package whose checksum covers a descriptor pointing at code the checksum does
not cover:

    research.browser     npx @playwright/mcp@latest --headless
    research.context7    npx -y @upstash/context7-mcp
    research.paperclip   /home/bbbee/projects/paperclip/.venv/bin/fastmcp …

The first two fetch unpinned remote code at launch. The third is worse in a
quieter way: an absolute path into a working directory, editable at any time by
anyone with the account, wearing the appearance of a pinned capability. The
rule caught three real defects. It should not be relaxed to admit `npx`, and
wrapping npx in a launcher script would be the same defect with indirection.

**What a fix would actually take.** The current mechanism copies only the arg
file, so a server runs only if it is a single, self-contained,
location-independent file. Measured against `@upstash/context7-mcp`, the
lightest of the three:

- 89 packages, 30 MB installed; `dist/index.js` alone dies on
  `Cannot find package '@modelcontextprotocol/node'`.
- Bundled with esbuild it becomes one 3.7 MB file — and still fails, because it
  reads a `package.json` two directories above itself, a path baked in from its
  original layout.

So bundling does not rescue it, and vendoring means 30 MB of transitive
dependencies inside a checksummed package. Playwright is further out of reach:
it drives browsers and will not usefully bundle at all.

The gap is real and worth naming: `materializeMcpServerIntoCapsule`'s own
comment promises to copy "capability-owned MCP runtime scripts", but the code
only accepts absolute host paths, which is precisely what a package cannot own.
A package-relative runtime would close it. That is a feature, and it does not
make the two npm servers work by itself.

**Done for now:** the three assignments are disabled, so Reanna launches again.
She is degraded, not dead — `network: true` gives her `WebFetch` and
`WebSearch`; what she loses is JavaScript-rendered pages and curated docs
lookup. Re-enabling is one `capability enable` per package once a runtime
mechanism exists.

One thing already handled: changing any of these packages moves its checksum
and strands the assignment rows keyed on the old one. `team-up doctor` reports
that as `assignment_unknown_package` at high severity.

### A capability became unremovable the first time anything used it

Found while removing `research.paperclip`, which Benni had installed to try
once and never used. The removal was refused:

    CAPABILITY_REFERENCED: active run 20260827T184044Z-o3b7

`activeRunsWithCapabilities` in `src/capabilities/cli.mjs` enumerated every run
directory containing an `EFFECTIVE_CAPABILITIES.json` and never looked at its
status. Every run that has ever launched with a capability leaves that file
behind, so the guard called "active runs" was really "all runs, forever" — the
same shape as `materializeMcpServerIntoCapsule`, whose comment promises
capability-owned runtimes while the code accepts only host paths. A name that
says one thing and code that does another, twice in one subsystem.

It now skips runs in `done`, `failed` or `cancelled`. A run whose `STATE.json`
cannot be read still blocks: refusing to remove a package is recoverable,
removing one out from under a live worker is not.

Two stale runs surfaced behind it, both stuck in `handing_off` — one from
2026-08-15 naming `team-up-testing-hannes-…`, from before the rename. That
status is in gc's `PROTECTED` set, correctly, because a quota handoff must not
be killed mid-flight. But there is no upper bound on it: neither run had a
heartbeat file or a live tmux session, and both would have sat there
indefinitely holding capabilities. **A protected run with no tmux and no
heartbeat cannot be handing off to anything — gc has no rule for that, and
adding one is a change to reaper semantics, so it is recorded here rather than
made.**

Cleaned up along the way: two empty pool directories, `research.paperclip` left
by its own removal and `o9k.caveman` left by the rename to `style.caveman`.
`removeCapability` deletes the checksum tree and leaves the id and version
directories behind.

### One flaky test

`STATE lock contention respects a bounded timeout` failed twice while the
machine was busy killing processes, then passed five runs in a row. Timing
sensitive, not caused by any change here — but it will fail in CI on a loaded
runner.

## Step 7 — A catalogue in this repo — DONE, at the lowest useful rung

One repo per specialist means discovery has to live somewhere. `catalogue.json`
at the repo root is that somewhere: the four published specialists and the five
capability packages, each with id, version, repo, call types, the permissions
it asks for, what it needs from the project, and its caveat.

The three design questions this step opened — where the list lives, whether
installing means cloning or fetching a release, how it relates to
`capabilities/` — are **not answered, deliberately**. The need was "where do I
find the specialists", and a static file answers it. Nothing resolves the
catalogue at runtime; installing is still `git clone` then `specialist
install`. Build the registry when a static list actually stops working.

The honest weakness is drift, and it was already there: the `## Starters`
section in `docs/specialists.md` listed two of four specialists and no repo
URLs. That section now points at the catalogue instead of repeating it.

`test/catalogue.test.mjs` checks what it can. Every capability entry is
verified against the `capability.json` it names, and every package in
`capabilities/` must appear — that caught `style.caveman` listed at 0.1.0 when
it is 1.0.0, on the first run. The specialist half cannot be checked the same
way: those are separate repos, so a version can move there without this file
noticing. Named rather than papered over.

## Open questions for Benni

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
