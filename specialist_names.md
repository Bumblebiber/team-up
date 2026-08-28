# Specialists

Each specialist gets its own folder with its own skills, and where possible its
own plugins and MCPs. That is what keeps the main agent's context window clean.

Scoping is already built: `capability enable --for <specialist>` marks packages,
and every run materializes only the effective set into a capsule — skills via
the run's `CLAUDE_CONFIG_DIR`, plugins via `--plugin-dir`, MCPs via
`--strict-mcp-config --mcp-config`. Claude only; opencode has no `--plugin-dir`
equivalent, so a capsule reaches it as skills alone.

Naming follows the two installed specialists: id is `domain.firstname`, the
bundle lives in its own repo `team-up-with-<name>`, manifest is
`specialist.json` at schema_version 2.

## Agreed

| Name | Role | id |
|---|---|---|
| Revan the reviewer | reviewer | `review.revan` |
| Reanna the researcher | researcher | `research.reanna` |
| Codey the coder | implementer | `coding.codey` |
| Platon the planner | planner | `planning.platon` |
| Orlando the organizer | — | `organizing.orlando` |
| Prosper the prompt-writer | prompt-writer | `prompting.prosper` |
| Frodo the frontend designer | frontend-designer | `frontend.frodo` |
| Scott the scout | scout | `scouting.scott` |
| Susy the summarizer | summarizer | `summary.susy` |
| Ada the advisor | advisor | `advice.ada` |

Already installed and staying: `testing.tessa` — Tessa, test strategy and
verification review.

Dropped:

- **An observer specialist.** The roster keeps the `observer` role; nothing needs a capability bundle behind it.
- **Libby the librarian.** Knowledge management is Orlando's, and it already overlaps TIM; two specialists for it was one too many.
- **Hugo.** The researcher is Reanna. `research.hugo` is installed and has its own repo, so this is a rename to carry out, not just a line to delete — see below.

## The Tessa rename — done

Tessa was the first of these bundles and predates the rule the others follow,
where the name alliterates with the role. Revan reviews, Reanna researches,
Codey codes; Tessa tested. He is now **Tessa**, `testing.tessa`, and the repo
is [team-up-with-tessa](https://github.com/Bumblebiber/team-up-with-tessa) —
GitHub redirects the old name.

Nothing about the remit, permissions or capabilities changed. The id did, so
the store treats it as a different specialist: `testing.tessa@0.1.0` is
installed and approved, and `testing.tessa@0.1.0` is still installed because
three unfinished runs from 2026-08-15 reference it. `uninstall` refuses while
that is true, correctly — a resume re-verifies the package checksum, so
removing it early turns into an integrity failure later. It goes once those
runs are closed out.

Twenty-two files in this repo carried the name, almost all tests. One
expectation had to be reordered: capability ids are sorted, and
`example.tessa` sorts after `example.shared` where `example.tessa` sorted
before it — the same trap the Hugo rename hit.

The design records under `docs/specs/` and `docs/superpowers/` still say
Tessa. They are dated history, not current documentation, which is the same
call made for Hugo.

## The Hugo rename — done

`research.hugo` was not just a name in this list. It was installed, had its own
repo, and was named across ten files in team-up. All of it now says Reanna:

- The repo is `~/projects/team-up-with-reanna` on branch `rename/reanna`; `specialist.json` is `research.reanna` / "Reanna". **The git remote still points at `Bumblebiber/team-up-with-hugo`** — renaming it on GitHub is a separate step.
- Eight test files plus `docs/specialists.md` and `docs/configuration.md`. The fixture capability `hugo.search` became `reanna.search`, which changed its sort position and needed one expectation reordered in `capabilities/resolve.test.mjs`.
- `research.reanna@0.1.0` is installed and approved for `~/projects/o9k`, matching Hugo's old approval.
- The design records under `docs/specs/` and `docs/superpowers/` keep saying Hugo. They are dated history, not current documentation.

The manifest carried over unchanged, and it is a good researcher spec:

- remit: source discovery, evidence synthesis, provenance, uncertainty reporting
- anti-remit: unsourced factual invention, code mutation, deployment
- `filesystem: project_readonly`, `writes: false`, `network: true`, no commands
- `model_profile: { tier: medium, reasoning: low }` — deliberately not a frontier model

Still there: the old `research.hugo` entries in `~/.team-up/specialists-index.json`
and `approvals.json`. `team-up specialist` has no `uninstall`, so removing them
means editing the state store by hand. Nothing points at them, so they are dead
weight rather than a problem.

## Proposed, no decision yet

Domains with no roster role today, listed by how often the work actually comes up:

- **Sentinel the security auditor** (`security.sentinel`) — STRIDE / OWASP passes; a distinct skill set and a remit that is easy to bound.
- **Dora the debugger** (`debugging.dora`) — reproduce, hypothesize, fix. Different tools from the coder.
- **Milo the migrator** (`migration.milo`) — version and schema moves. This is the class of work that leaves dangling paths behind.
- **Otto the operator** (`ops.otto`) — systemd, cron, deploys.

## Order of work

Build one end to end before defining the rest. The capability pool currently
holds a single package, so there is nothing to assign yet.

1. `team-up capability scan --root ~/.claude/skills` — fills the pool from the
   81 skills already installed, and yields the checksums `capability enable`
   requires.
2. Define one specialist completely, copying the `team-up-with-tessa` shape:
   `specialist.json`, `instructions.md`, `skills/`, `evals/evals.json`.
   Revan is the best first candidate — the `code-review` skill and the
   `reviewer` role both exist, and the remit is sharp.
3. Assign it, launch it once, read `EFFECTIVE_CAPABILITIES.json`, and confirm
   the capsule contains only what was enabled.

Then repeat. Defining ten specialists and hunting packages for each before one
has round-tripped is speculative.
