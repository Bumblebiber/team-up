<!-- o9k-provenance
who: codex:gpt-5
when: 2026-07-26
why: Record the user-approved capability pool and specialist context isolation design
trigger: Soll ich ihn jetzt als Spec im team-up-Repo festhalten? — ja
host: codex
-->
# Capability Pool and Specialist Context Isolation

## Status

Approved design, ready for implementation planning.

## Purpose

Specialist workers must receive only the skills, plugins, MCP tools, and
frameworks that belong to them or that the human explicitly enabled for them.
Globally installed harness capabilities must not fill unrelated specialists'
context windows.

This is context isolation, not a security boundary. Specialists continue to
run under the same trusted Unix user. The design does not attempt to prevent a
deliberately hostile same-UID process from reading files.

## Decisions

- There is no built-in mandatory capability baseline.
- Every shared capability is human-selected and removable.
- A selection for `all` applies to current and future specialists.
- An explicit specialist exclusion overrides `all`.
- Only the human-facing supervisor may mutate capability assignments.
- One compact operator skill, `/team-up-manage`, manages every capability
  type and every specialist.
- Installation into the pool and activation for specialists are separate.
- Specialist recommendations are never preselected or activated
  automatically.
- Global harness discovery is disabled for specialist runs.
- A harness that cannot prove context isolation is ineligible for specialist
  runs.

## Terminology

### Capability package

An immutable package that provides one or more skills, plugins, MCP servers,
or frameworks. A package may be a bundle containing several of these types.

### Pool

The content-addressed store of installed capability packages. Packages in the
pool are inert until an assignment activates them.

### Assignment

A human-controlled mapping from one immutable package version to `all` or
specific specialist IDs, with optional specialist exclusions.

### Intrinsic capabilities

Files shipped as part of a specialist package and required to instantiate that
specialist. Existing specialist manifest fields such as
`capabilities.skills` remain intrinsic. Shared pool assignments do not modify
the specialist package.

### Run capsule

The minimal, run-specific skills, plugins, MCP configuration, framework files,
and harness settings materialized for one specialist invocation.

### Operator skill

The human-facing `/team-up-manage` skill. It is available to the supervisor,
not materialized into specialist workers.

## Capability Package Manifest

All imported packages normalize to one manifest:

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
  "permissions": {
    "network": false,
    "commands": []
  }
}
```

`provides` always contains arrays for all four types. A framework or bundle may
populate several arrays. Every referenced path must be relative, remain inside
the package root, and exist at import time.

The normalized pool record additionally stores:

- immutable source metadata;
- exact Git commit when imported from Git;
- package checksum;
- import timestamp;
- estimated skill-description tokens;
- declared MCP tool count;
- plugin and framework metadata;
- validation warnings.

Concrete models and providers remain forbidden in capability packages.

## Pool Storage

Packages are stored by identity, version, and checksum:

```text
~/.team-up/capability-pool/
└── o9k.caveman/
    └── 1.2.0/
        └── <sha256>/
            ├── capability.json
            ├── source.json
            └── package/
```

Import is atomic. Files are copied into a temporary sibling directory,
validated and checksummed, then renamed into place. A failed import leaves no
pool index entry or partial destination.

No foreign lifecycle script is executed during import. A package requiring
runtime dependencies must provide directly usable artifacts or a declarative,
isolated dependency description supported by a future versioned adapter.

## Sources and Detection

`/team-up-manage install` accepts:

- a local filesystem path, including paths below the user's existing skill or
  plugin directories;
- a Git URL with a branch, tag, or commit;
- a specialist recommendation containing an explicit source.

Git input is resolved to an exact commit before installation. The commit and
checksum are recorded. Moving branches or tags never mutate an installed pool
entry.

Import detection recognizes known skill, plugin, MCP, framework, and bundle
layouts. Ambiguous input requires a human choice. Detection never activates
the package.

## Assignment Model

Assignments are stored separately from pool contents:

```json
{
  "schema_version": 1,
  "assignments": [
    {
      "package": "o9k.caveman@1.2.0",
      "checksum": "sha256:...",
      "targets": ["all"],
      "exclude": ["research.hugo"]
    }
  ]
}
```

Rules:

1. `targets` contains `all` or explicit specialist IDs.
2. `all` dynamically includes specialists installed in the future.
3. An ID in `exclude` always wins over `targets`.
4. Duplicate effective package versions collapse by checksum.
5. Conflicting versions of the same package fail resolution and require a
   human decision; no implicit newest-version choice is allowed.
6. Disabling a package for one specialist adds an exclusion. It does not
   uninstall the package.
7. Re-enabling removes the exclusion.

For specialist `S`, the effective package set is:

```text
intrinsic specialist package
+ assignments targeted to all or S
- assignments explicitly excluding S
```

Intrinsic specialist files are not shared assignments. To change them, the
human installs or selects a different specialist package version.

## Human-Facing Management

The main `team-up` repository ships one compact operator skill:

```text
/team-up-manage
```

It drives deterministic CLI commands rather than implementing storage or
resolution itself.

Representative CLI surface:

```bash
team-up capability scan
team-up capability inspect <source-or-id>
team-up capability install <source>
team-up capability enable <id@version> --for all
team-up capability enable <id@version> --for research.hugo
team-up capability disable <id@version> --for research.hugo
team-up capability update <id>
team-up capability rollback <id>
team-up capability remove <id@version>
team-up capability list
```

The operator skill presents chat-native opt-in lists on headless servers. The
CLI also accepts explicit flags for deterministic noninteractive operation.

Before confirmation it displays:

- source and resolved version or commit;
- checksum;
- provided skills, plugins, MCPs, frameworks, and bundles;
- MCP tool count;
- estimated context cost;
- requested network, command, and filesystem permissions;
- installed specialists plus an `all` option.

Nothing is preselected.

Separate commands such as `/hugo-skill-install`,
`/team-up-mcp-install`, or `/hugo-disable-skill` are intentionally rejected:
they would expand the supervisor's skill catalog and duplicate management
logic. Equivalent operations use `/team-up-manage` with an explicit target.

## Specialist Recommendations

A specialist manifest may contain recommendations:

```json
{
  "recommendations": [
    {
      "package": "o9k.caveman",
      "source": "https://github.com/example/caveman.git",
      "reason": "Reduces routine output",
      "suggested_target": "research.hugo"
    }
  ]
}
```

Recommendations are display metadata only. When installing or inspecting the
specialist, `/team-up-manage` shows an opt-in list with no selected entries.
The suggested target saves typing after selection but grants no authority and
does not alter state.

## Run Resolution and Materialization

Before creating a worker process, `team-up`:

1. loads the pinned specialist package;
2. resolves assignments for the specialist ID;
3. applies exclusions;
4. rejects version conflicts, missing checksums, or invalid packages;
5. expands selected bundles into their declared components;
6. calculates context and MCP tool totals;
7. materializes only the effective set into a run capsule;
8. writes `EFFECTIVE_CAPABILITIES.json`;
9. asks the harness adapter to launch exclusively from the capsule.

The pool index, non-selected package descriptions, and available-package
catalog are never included in the worker prompt or tool schemas.

Example capsule:

```text
<run>/
├── context/
│   ├── specialist/
│   ├── skills/
│   └── framework/
├── harness/
│   ├── plugins/
│   ├── mcp.json
│   ├── settings.json
│   └── home/
└── EFFECTIVE_CAPABILITIES.json
```

The effective-capabilities record contains package IDs, versions, checksums,
selection reasons, exclusions, resolved paths, estimated context cost, and MCP
tool names. It is an audit artifact and is not injected wholesale into the
model context.

## Harness Context-Isolation Contract

Harness adapters gain a versioned capability:

```text
team-up.context-isolation/v1
```

The contract requires the adapter to:

- disable user- and project-global skill, plugin, hook, framework, and MCP
  discovery;
- load skills and frameworks only from capsule paths;
- load plugins only from explicit capsule paths;
- expose MCP servers and tool schemas only from the generated strict
  configuration;
- preserve authentication without importing global capability configuration;
- report the exact effective capability list used at launch.

Claude launches use bare mode, explicit plugin directories, and strict MCP
configuration. Codex launches use a run-specific `CODEX_HOME` containing only
the selected skills and minimal configuration. Authentication is bridged
separately from capability discovery. Other harnesses implement equivalent
adapters.

This is not an OS-security boundary. The same Unix user remains trusted.

If a harness cannot prove the contract, profile resolution excludes it from
specialist chains. Context isolation is fail-closed rather than a warning.

## Conformance Verification

Each harness adapter must pass a live conformance fixture containing:

- one globally installed canary skill;
- one globally installed canary plugin;
- one globally configured canary MCP;
- one selected capsule skill;
- one unselected pool skill;
- one selected MCP tool;
- one excluded MCP tool;
- one selected framework;
- one unselected framework.

The verification succeeds only when:

- selected capabilities are visible and usable;
- global canaries are absent;
- unselected and excluded capabilities are absent;
- the observed MCP tool list exactly matches the effective selection;
- the adapter's report matches `EFFECTIVE_CAPABILITIES.json`.

Verification is version-keyed to the harness executable. A harness update
invalidates prior verification until conformance is rerun.

## Updates, Rollback, and Removal

Updates install a new immutable version beside the old one. Existing
assignments remain pinned until the human selects the new version. Historical
and active runs retain their original checksums and capsule contents.

Rollback changes an assignment to a previously installed checksum. It does not
rewrite the package or old runs.

Removal is refused while any assignment or active run references the exact
version and checksum. A recommendation alone is inert and does not pin an
installed version. Removing an unreferenced version never changes other
versions.

## Existing Installation Scan

`/team-up-manage scan` inspects known local skill and plugin roots and reports
import candidates. Scanning is read-only. It never imports, activates, or
rewrites the original installation.

The human selects candidates, reviews normalized manifests, and chooses
targets through the normal installation flow. Existing globally installed
capabilities remain ignored by specialist runs even when they have not been
imported.

## Failure Handling

- Invalid paths, manifests, checksums, or permissions abort before state
  mutation.
- A dependency failure removes the temporary import directory.
- Assignment writes use atomic replacement and preserve the prior document on
  validation failure.
- Missing assigned packages block the specialist launch with an actionable
  error.
- Version conflicts block launch and list the conflicting selectors.
- Harness conformance failure removes that harness from eligible chains.
- Run capsule construction failure creates no worker process.

## Acceptance Tests

### Pool and assignment

- Local and Git imports produce identical checksums for identical contents.
- Git branches and tags resolve to immutable commits.
- Failed imports leave no files or index entries.
- `targets: ["all"]` includes specialists installed later.
- Explicit exclusions override `all`.
- Re-enable removes an exclusion without reinstalling the package.
- Conflicting package versions fail deterministically.

### Materialization

- Only intrinsic and effectively assigned files enter the capsule.
- Hannes never receives Hugo-only capabilities.
- Hugo never receives Hannes-only capabilities.
- Bundles expose only declared components.
- Non-selected package descriptions consume no worker-context tokens.
- `EFFECTIVE_CAPABILITIES.json` matches materialized files.

### Harnesses

- Global canary skills, plugins, MCPs, and frameworks are absent.
- Selected capsule capabilities are present.
- Excluded and unselected MCP tool schemas are absent.
- Harness version changes invalidate isolation verification.
- An unverified harness is excluded before worker creation.

### Lifecycle

- Updates do not mutate assignments or active runs.
- Rollback selects the exact prior checksum.
- Referenced versions cannot be removed.
- Recommendations remain inactive until explicit human opt-in.
- Specialist workers cannot see the operator skill.

### Context measurement

- Tests record the prompt tokens and MCP schema bytes contributed by each
  effective package.
- Adding an unassigned pool package does not change a worker's prompt or tool
  schema size.
- Excluding a previously shared package removes its context and tool-schema
  contribution from the next run.

## Rollout

1. Implement the generic pool, normalized manifest, atomic import, assignment
   resolver, and `/team-up-manage` local-source workflow.
2. Add run capsules and Claude `context-isolation/v1` conformance.
3. Add Git imports, recommendations, update, rollback, removal, and scanning.
4. Add verified context-isolation adapters for additional harnesses.

No phase enables automatic recommendations or a mandatory baseline.

## Rejected Alternatives

### Expanding `all` to current specialist IDs

Rejected because future specialists would not inherit the human's intended
shared selection.

### Separate installer skills per capability type or specialist

Rejected because they would bloat the supervisor context and duplicate logic.

### Globally installing selected packages into each harness

Rejected because global discovery is the source of cross-specialist context
leakage.

### Container or per-specialist Unix-user isolation

Rejected because the goal is context hygiene, not hostile-process isolation.
