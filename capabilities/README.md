# Capability package sources

Importable sources for the packages in this repo's own roster. The pool under
`~/.team-up/capability-pool/` is content-addressed and holds only the imported
copy, so a package that exists nowhere else cannot be reviewed, diffed, or
rebuilt. These directories are that missing original.

```bash
team-up capability install capabilities/research.context7
team-up capability enable research.context7@1.0.0 \
  --checksum <sha256 from the install output> --for research.reanna
```

Nothing here is enabled by being present. Import puts a package in the pool;
a human assignment is what lets a specialist see it.

## What belongs in `tools`

A descriptor's `tools` array is the specialist's allowlist for that server —
list the tools the package is meant to grant, not every tool the server
happens to expose. Omitting the array grants the whole server, which is only
right when every tool on it fits the narrowest specialist that will hold the
package.

`research.browser` is the clear case. `@playwright/mcp` also exposes
`browser_run_code_unsafe`, `browser_evaluate`, `browser_file_upload`,
`browser_fill_form`, `browser_click` and `browser_type`. A researcher reading
sources needs none of them, and two of them — arbitrary code in the page, and
uploading a local file — would route straight around a `writes: false`,
`project_readonly` manifest. The package therefore lists reads only.

That subset does cost something: no clicking means a page behind a cookie
banner or a "load more" button may not open. Adding a tool later is a version
bump and a re-approval, which is the cheap direction to be wrong in.

## Host-specific packages

`research.paperclip` is installed in the pool but has no source here: its
descriptor points at an absolute path to a local checkout
(`~/projects/paperclip`), so committing it would publish a package that
resolves on exactly one machine. The two here run through `npx` and work
anywhere node does.

Never build a descriptor by copying from `~/.mcp.json`. That file holds live
credentials in cleartext, and a capability package is content-addressed with a
public remote — the copy would be permanent. Hand-write the descriptor with
only the fields the server needs.
