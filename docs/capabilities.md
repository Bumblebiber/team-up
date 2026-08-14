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
└── o9k.caveman/
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
  "id": "o9k.caveman",
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
      "package": "o9k.caveman@1.2.0",
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

**Claude** launches with a run-specific `CLAUDE_CONFIG_DIR`, explicit
`--plugin-dir` entries, `--strict-mcp-config`, `--setting-sources user`, and a
`--tools` allowlist built only from selected tools. Only credential files are
bridged into that config dir — never settings, skills, or plugins.

Three details are load-bearing and were each confirmed against the CLI:

- Skills resolve **only** from `$CLAUDE_CONFIG_DIR/skills`, so every selected
  skill is linked there. Materializing into `context/skills` alone loads
  nothing.
- Without `--setting-sources user` the **project's** own `.claude/` skills,
  plugins and hooks load on top of the capsule. Redirecting the config dir
  hides user-global capabilities only.
- A `--tools` allowlist that omits `Skill` silently disables every skill, so
  the tool is added whenever a capsule selected skills or skill-bearing
  plugins. Plugin skills appear as `<plugin>:<skill>`.

The CLI's own bundled skills remain visible. They ship with the harness
executable rather than with a user or project configuration, and they are the
floor no capsule can go below.

`--bare` is **opt-in** (`capsule.bare`), not unconditional: it never reads
OAuth or keychain credentials, so forcing it would break every
subscription-authenticated launch. Use it for API-key launches.

Verification is version-keyed to the harness executable, and a verified record
grants only what it actually proved: a proven command broker never implies
context isolation. A harness that cannot prove the contract is excluded during
profile resolution, before any worker process exists.

### Live conformance

`team-up harness verify claude` proves isolation on its own launch. It plants
a user-global canary skill, a project-local canary skill, an unselected pool
skill, and a global MCP server around a capsule that selects exactly one skill
and one plugin, then asks the harness to report its effective capabilities.

The selected skill and plugin are **positive controls**. If they are missing,
the launch mechanism itself failed and the run's clean canary sheet proves
nothing, so the result is `failed` — never `passed`. An unparseable report is
`unverified`. The record stores `context_isolation_planted` so an unplanted
canary's absence is never mistaken for an exercised one.

Cursor, Codex, Hermes, and OpenCode have no isolation adapter yet and are
therefore ineligible for specialist runs.

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
      "package": "o9k.caveman",
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
