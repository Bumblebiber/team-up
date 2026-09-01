# Capability package sources

Importable sources for the packages in this repo's own roster. The pool under
`~/.team-up/capability-pool/` is content-addressed and holds only the imported
copy, so a package that exists nowhere else cannot be reviewed, diffed, or
rebuilt. These directories are that missing original.

```bash
team-up capability install capabilities/ponytail.build
team-up capability enable ponytail.build@4.8.4 \
  --checksum <sha256 from the install output> --for coding.codey
```

Nothing here is enabled by being present. Import puts a package in the pool;
a human assignment is what lets a specialist see it.

## What belongs in `tools`

A descriptor's `tools` array is the specialist's allowlist for that server —
list the tools the package is meant to grant, not every tool the server
happens to expose. Omitting the array grants the whole server, which is only
right when every tool on it fits the narrowest specialist that will hold the
package.

`research.browser`, dropped from this tree but worth keeping as the example, is the clear case. `@playwright/mcp` also exposes
`browser_run_code_unsafe`, `browser_evaluate`, `browser_file_upload`,
`browser_fill_form`, `browser_click` and `browser_type`. A researcher reading
sources needs none of them, and two of them — arbitrary code in the page, and
uploading a local file — would route straight around a `writes: false`,
`project_readonly` manifest. The package therefore lists reads only.

That subset does cost something: no clicking means a page behind a cookie
banner or a "load more" button may not open. Adding a tool later is a version
bump and a re-approval, which is the cheap direction to be wrong in.

## `style.caveman`, formerly `style.caveman`

The caveman package never depended on o9k. It is thirteen lines of hand-written
skill about how to write, with no import, tool call or path pointing at o9k —
the name was the only connection, and it outlived the thing it named. Renamed
to `style.caveman` once o9k was retired.

Two things the rename fixed beyond the name.

Its recorded source was `/tmp/cap-caveman`, a directory that is now empty. The
package existed only as its pool copy: unreviewable, undiffable, impossible to
rebuild — exactly the case the top of this file describes. The source now lives
here, and the content is byte-identical to what was in the pool.

Note what it is *not*: `~/.agents/caveman.md` and the output style synced from
it are 64 and 73 lines, with sections about memory writes, boundaries and an
off switch that only make sense on a host. This package is a deliberate
reduction for a capsule. If the two should converge, that is a content decision
and a version bump, not a rename.

`style.caveman@1.0.0` is unassigned but still in the pool: three unfinished runs
from 2026-08-15 name it in their state, and `capability remove` refuses while
that holds — a resume re-verifies the checksum. It goes when they are closed.

## Vendored skill packages

`ponytail.build` and `ponytail.review` are the only packages here that carry
skill files rather than an MCP descriptor. Both vendor from
[ponytail](https://github.com/DietrichGebert/ponytail) 4.8.4, MIT, © 2026
Dietrich Gebert — the upstream `LICENSE` sits beside each `capability.json`,
and each vendored `SKILL.md` carries an attribution line, because the pool copy
holds only the files a package declares and a licence cannot be declared.

The split is deliberate. Upstream ships six skills; installing all six to get
one is the mistake this whole pool exists to avoid.

| Package | Skills | For |
|---|---|---|
| `ponytail.build` | `ponytail` | an implementer — the ladder that stops at the first rung that holds |
| `ponytail.review` | `ponytail-review`, `ponytail-debt` | a reviewer — hunting complexity rather than correctness, plus the ledger of deliberate shortcuts |

`ponytail-audit`, `ponytail-gain` and `ponytail-help` are not packaged: nothing
in the current roster has a use for them.

Cost, measured at import: `ponytail.build` is 1,696 estimated description
tokens and `ponytail.review` 1,094. That is not free for a specialist whose
value is being narrow, and it is why these are enabled per specialist rather
than for `all`.

## Host-specific packages

A descriptor pointing at an absolute path into a local checkout publishes a
package that resolves on exactly one machine, so it does not belong here.
`research.paperclip` was that shape — `~/projects/paperclip/.venv/bin/fastmcp`
— and has been removed entirely: the capsule only starts the node binary, so a
Python server cannot be a capability at all, whatever else is fixed.

**`npx` does not work either, and the reason matters.** `research.context7`
still declares `npx -y @upstash/context7-mcp` and will be refused at capsule
build with `MCP_RUNTIME_COMMAND_DENIED`. That is correct: a content-addressed
package whose checksum covers a descriptor that fetches unpinned remote code at
launch is not pinned in any useful sense. The checksum covers the pointer, not
what it points at.

What the capsule accepts is the node binary plus absolute paths to regular
files, which it copies in and sets read-only. Only the argument file is copied,
not its `node_modules`, so a server runs only if it is a single, self-contained,
location-independent file. Measured against `@upstash/context7-mcp`: 89
packages and 30 MB installed; its entry alone dies on a missing dependency;
bundled to one 3.7 MB file it still fails, because it reads a `package.json`
two directories above itself.

So `research.context7` is kept as a record of the intent and is **not usable as
shipped**. `research.browser` was dropped: twelve tool schemas in every
researcher's context, the largest overlap with the `WebFetch` a networked
specialist already has, and Playwright drives browsers, so it will not bundle
at all.

Never build a descriptor by copying from `~/.mcp.json`. That file holds live
credentials in cleartext, and a capability package is content-addressed with a
public remote — the copy would be permanent. Hand-write the descriptor with
only the fields the server needs.
