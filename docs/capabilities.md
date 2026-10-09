# Capabilities

Shared skills, plugins, MCPs, frameworks, and bundles live in a
content-addressed **pool**. They are inert until a human **assigns** them.
Each specialist run materializes only its effective set into a **run capsule**.

There is **no mandatory baseline**. Every shared capability is human-selected
and removable.

## Pool layout

```text
~/.team-up/capability-pool/
├── index.json
└── style.caveman/
    └── 1.2.0/
        └── <sha256>/
            ├── capability.json      # package identity + checksum
            ├── source.json          # immutable source metadata
            └── package/             # manifest + declared files only
```

Import is atomic: files are staged in a sibling directory, validated and
checksummed, then renamed into place. A failed import leaves no pool entry.
No lifecycle script from the package is ever executed.

## Capability manifest

```json
{
  "schema_version": 1,
  "id": "style.caveman",
  "version": "1.2.0",
  "display_name": "Caveman",
  "provides": {
    "skills": ["skills/caveman/SKILL.md"],
    "plugins": [],
    "mcps": [],
    "frameworks": []
  },
  "permissions": { "network": false, "commands": [], "filesystem": "none" }
}
```

`provides` normalizes to all four arrays. Every declared path must be
relative, stay inside the package root, and exist at import time. Symlinks are
refused. Concrete model or provider names and install hooks are forbidden keys.

## Assignments

```json
{
  "schema_version": 1,
  "assignments": [
    {
      "package": "style.caveman@1.2.0",
      "checksum": "sha256:…",
      "targets": ["all"],
      "exclude": ["research.rick"]
    }
  ]
}
```

The effective set for specialist `S` is:

```text
  intrinsic specialist package
+ assignments targeted to all or S
- assignments explicitly excluding S
```

- `all` dynamically includes specialists installed **later**.
- An exclusion always beats `all`; re-enabling removes the exclusion.
- Identical checksums selected twice collapse.
- Two different versions of one id fail with `CAPABILITY_VERSION_CONFLICT`.
  There is no implicit newest-version choice.
- An assigned package missing from the pool fails with `CAPABILITY_MISSING`.

## Run capsule

```text
<run>/
├── context/
│   ├── specialist/      # intrinsic package files
│   ├── skills/
│   └── framework/
├── harness/
│   ├── plugins/
│   ├── claude-mcp.json  # strict MCP config
│   └── home/            # run-specific harness config dir
├── claude-home/          # auth-only HOME with selected skills and onboarding keys
└── EFFECTIVE_CAPABILITIES.json
```

`EFFECTIVE_CAPABILITIES.json` is an audit artifact: package ids, versions,
checksums, selection reasons, exclusions, resolved capsule paths, and context
totals. It is never injected wholesale into the worker prompt. Neither is the
pool index or any unselected package description.

Path collisions between two packages fail with `CAPSULE_PATH_COLLISION`, and
duplicate MCP server names fail with `MCP_NAME_COLLISION`, before any worker
starts.

## Harness contract

```text
team-up.context-isolation/v1
```

A harness adapter must disable user- and project-global skill, plugin, hook,
framework, and MCP discovery; load only from capsule paths; expose only the
generated strict MCP configuration; preserve authentication without importing
global capability configuration; and report its exact effective capability
list.

**Claude** launches with `HOME` set to a run-specific, auth-only home
(`<run>/claude-home`), explicit `--plugin-dir` entries, framework directories
on `--add-dir`, `--strict-mcp-config --mcp-config <run>/harness/claude-mcp.json`,
`--setting-sources user`, a `--tools`/`--allowedTools` allowlist built only
from the permitted built-ins and selected MCP tools, and `--disallowedTools`
for `Bash` plus the credential-file read rules. The home is rebuilt from empty
staging for every attempt and holds only `.claude/.credentials.json`, the
selected skills under `.claude/skills/`, and a `.claude.json` carrying the
first-run markers and workspace trust for the context dir and project — never
the user's settings, plugins, MCP servers or other skills. The home is built
once for the run. The worker's cwd is
`<run>/context` (`capsuleContextDir`).

Three details are load-bearing and were each confirmed against the CLI:

- Skills resolve from `$HOME/.claude/skills`, so every selected skill is
  copied into the run home. Materializing into `context/skills` alone loads
  nothing.
- Claude reads `.claude/skills` and `CLAUDE.md` from the cwd **and every
  directory above it** as project config. A run's cwd sits under the user's
  real home, so without `--setting-sources user` the host's own skills and
  `CLAUDE.md` files load into every capsule as "Project" config. Redirecting
  `HOME` hides only the user-level ones. Measured on 2.1.286 in the
  production layout with `claude --print`: 88 skills (68 of them the host's)
  and both host `CLAUDE.md` files without the flag; 21 skills (the selected
  ones and the CLI's built-ins) and no instructions file with it. Moving the
  cwd out of the home is not a substitute: a `/tmp` cwd loaded a `CLAUDE.md`
  planted in its own parent just the same.
- A `--tools` allowlist that omits `Skill` silently disables every skill, so
  `Skill` is on every capsule's allowlist. Plugin skills appear as
  `<plugin>:<skill>`.

The CLI's own bundled skills and plugins remain visible. They ship with the
harness executable rather than with a user or project configuration, and they
are the floor no capsule can go below.

`--bare` is never passed — an argv that carries it has it removed. It skips
OAuth and keychain credentials, so it would break every
subscription-authenticated launch; the auth-only `HOME` does its job instead.

Harness support comes from the installed adapter's declared capabilities.
Verification records are keyed to the installed CLI version and provide health
evidence only; their status does not grant or revoke launch capabilities. A
missing, failed, or drifted record is printed and stored as a launch warning,
and `team-up doctor` reports it at warning severity. It does not block a
supported capsule launch. The adapter still has to declare each required
capability, such as context isolation or command broker support.

### Live conformance

`team-up harness verify claude` proves isolation on its own launch
(`src/harness/isolation-canary.mjs`). The fixture builds a capsule that
selects one skill, one plugin, one framework and one MCP server, each carrying
a random nonce, through the same `prepareLaunch` a specialist uses, and plants
around it:

- user-global canaries — a skill, an installed plugin and an MCP server in
  `.claude.json` — in a separate global home. The probe's `HOME` is the
  capsule's auth-only home, which is checked closed-world before the run, so
  these show only that nothing from another home was copied in;
- an unselected pool skill and framework, and an excluded MCP package;
- an **ancestor** skill (`.claude/skills/ancestor.canary-skill`) and a
  `CLAUDE.md` with its own nonce in the fixture root, above the run directory —
  where the user's home sits above a production run.

The probe runs `claude --print --output-format stream-json` from
`capsuleContextDir(<fixture run>)`, the function the launcher takes a run's cwd
from, with the prepared `HOME` and the prepared argv's plugin, MCP, tool and
`--setting-sources` flags. A regression in the run's directory layout or in
the capsule flags therefore shows up in the canary.

What the canary does not cover: it measures `--print` mode only — the
`system/init` inventory and the `-p` session transcript — while production
workers run Claude interactively in tmux. An interactive capsule on 2.1.286
(probed once by hand, with the flag) loaded no host skills and no `CLAUDE.md`,
but its skill listing held 33 entries, not 21: on top of the selected skills
and the `-p` built-ins it carried 13 `anthropic-skills:*` entries that appear
to be synced from the Claude account (they are on no path under `HOME`), and
interactive-only built-ins (`artifact-*`, `claude-in-chrome`,
`keybindings-help`, `init`, `security-review`). Those are not on the
filesystem surface a capsule closes, and `--print` never lists them, so the
canary can neither see nor refuse them. An interactive leg of the canary is
still to be built.

Proof comes from the CLI's own structured output, never from the model's
answer. The `system/init` inventory may list only the selected set plus the
CLI's built-ins. Each selected capability is a **positive control**, proven by
a correlated tool call whose result carries its nonce; without them a clean
canary sheet proves only that the launch failed. `CLAUDE.md` never appears in
`system/init`, so the ancestor `CLAUDE.md` is judged from the session
transcript under the probe `HOME`: its nonce must be absent. Its positive
control is a user-level `CLAUDE.md` with its own nonce, which the probe writes
into its own `HOME/.claude/` after the closed-world check — the user source
stays on under `--setting-sources user`, and no production capsule home gets
one. That nonce must be present in the transcript, which proves the build
records instructions there at all (builds before 2.1.284 loaded `CLAUDE.md`
without recording it); otherwise the canary counts as not observed. Any
failed proof leaves the record without a grant, and `context_isolation_reason`
names the first one that failed.

The record stores `context_isolation_absent`, the forbidden canaries the run
observed absent, and the reason for any failed proof. Only Claude has a
specialist harness adapter today; other CLIs use the unsupported fallback.
Refresh the installed Claude version's health record with
`team-up harness verify claude`.

## Commands

```bash
team-up capability scan [--root <path>]…
team-up capability inspect <source-path | id@version [--checksum sha256:…]>
team-up capability install <source-path>
team-up capability install <git-url> --git-ref <branch|tag|commit>
team-up capability install <path> --type skill --id ID --version V --display-name NAME
team-up capability enable   <id@version> --checksum sha256:… --for all
team-up capability disable  <id@version> --checksum sha256:… --for research.rick
team-up capability list
team-up capability recommendations <specialist-id>
team-up capability update   <id@version> --from-checksum sha256:… --source <path>
team-up capability rollback <id@version> --from-checksum sha256:… --to <id@version> --checksum sha256:…
team-up capability remove   <id@version> --checksum sha256:…
```

Git refs resolve to an exact commit before import, so a moving branch or a
retagged release never mutates an installed entry.

`scan` is read-only. It reports candidates and never imports, activates, or
rewrites an existing global installation. A directory matching two layout
markers is reported `ambiguous` and requires an explicit `--type`.

## Lifecycle

- **Update** installs a new immutable version **beside** the old one and
  activates nothing. Existing assignments stay pinned until the human selects
  the new version.
- **Rollback** repoints assignment selectors to a previously installed
  checksum. It rewrites neither the package nor historical runs.
- **Removal** is refused while any assignment or unfinished run references
  that exact version and checksum. Removing an unreferenced version never
  touches its siblings.

## Recommendations

A specialist manifest may declare `recommendations`:

```json
{
  "recommendations": [
    {
      "package": "style.caveman",
      "source": "https://github.com/example/caveman.git",
      "reason": "Reduces routine output",
      "suggested_target": "research.rick"
    }
  ]
}
```

They are display metadata only. Nothing is preselected, no version is pinned,
and reading them mutates no state. Sources carrying credentials, or entries
with concrete model or install keys, are rejected at validation.

## Not a security boundary

This is context hygiene, not process isolation. Specialists remain trusted
processes under the same Unix UID as the controller, and the design does not
attempt to stop a deliberately hostile same-UID process from reading files.
See `docs/specialists.md` § Accepted same-UID trust boundary.
