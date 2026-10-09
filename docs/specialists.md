# Specialists

One repository = one specialist. Packages contain `specialist.json`,
instructions, skills, and evals — never concrete model/provider names or
executable install hooks.

## Lifecycle

```bash
team-up specialist inspect <path>
team-up specialist install <path>
team-up specialist trust-policy --project <absolute-path>
team-up specialist uninstall <id>@<version>
team-up specialist list
team-up specialist run --id <id> --call-type review --objective "..." --project <abs> [--cli <cli>] [--model <model>]
```

Installing or reinstalling a specialist is the trust decision. Its declared
files are copied into the content-addressed store and the installed version
becomes the selected version. Reinstalling another version selects it. Launch
still verifies the installed checksum every time before the package runs.

A specialist with command permissions needs a trusted project policy. Review
`.team-up/commands.json`, then run:

```bash
team-up specialist trust-policy --project /absolute/project/path
```

Trust is recorded by policy checksum. Editing the policy changes its checksum
and requires another trust decision. A worktree without its own policy uses its
main checkout's policy. When no policy exists, launch drops command permissions
and records `commandsUnavailable`; invalid or incomplete policies fail closed.

Installing another version selects it immediately. Uninstalling the selected
version selects the newest remaining version; uninstalling the last version
drops the specialist id. An unfinished run still blocks removal of the version
it uses.

`--cli` and `--model` override the cell for one run. A named model replaces the
specialist's chain with that one cell; `--cli` alone narrows the chain to that
CLI.
Everything else still gates it: account, harness capability (context isolation,
command broker) and usage windows are unchanged, so an override can only pick a
cell the gates already allowed. A named cell that no gate let through is refused
with `RUNTIME_OVERRIDE_UNAVAILABLE` and the reason it was dropped, never
silently swapped for another model.

`uninstall` removes one version, its package tree, and its index entry. It
refuses while an unfinished run still depends on that version — a resume
re-verifies the package checksum, so removing it early turns into an integrity
failure later instead of an error now. Removing the selected version selects
the newest remaining version. Removing the last version drops the id entirely.

## Call types

| Type | Default writes |
|------|----------------|
| consult | false |
| delegate | delegated_only |
| review | false |

Requests/results use `team-up.request/v1` and `team-up.result/v1` beside the
text mailbox for compatibility. Specialist runs set
`result_protocol: "RESULT.json"`; generic Path-B runs still close out with
`RESULT.md`.

## Permissions and fail-closed policy

Operating-system isolation via systemd-run `--user` is **best effort** for
installed specialists — not a security boundary. The launcher always
requests `enforcement: "best_effort"`: when a live semantic probe confirms
ProtectHome / NoExecPaths, the worker runs under systemd-run; when the probe
fails, launch continues without OS isolation and records an audit warning in
run state (`sandbox.enforced: false`). Callers outside that path still use
`enforcement: "required"` (fail-closed `SANDBOX_UNAVAILABLE`).

Declared filesystem and network permissions remain instructions plus audit
metadata. The home sentinel for the semantic probe stays under `$HOME`; the
no-exec probe script is created outside `$HOME` so home-hiding alone cannot
fake executable blocking.

**Command allowlists are hard at the harness/broker boundary.** Project
actions live in `.team-up/commands.json`, are trusted by checksum, and are
snapshotted under `~/.team-up/policy-snapshots/<runId>/` outside every
worker-writable path. The MCP broker validates that trusted checksum before
each action and never re-reads a worker-modifiable copy.
Authoritative launch descriptors live under
`~/.team-up/launch-descriptors/<runId>/` (checksum sidecar); `STATE.json`
holds only a `team-up.launch-ref/v1` pointer. Missing/corrupt descriptors or
required broker data fail closed. Under effective systemd isolation the
descriptor directory is bound read-only into the worker.

### Accepted same-UID trust boundary

Specialists are **trusted processes under the same Unix UID** as the
controller. The human accepted that a worker may escape best-effort OS
containment. A deliberately malicious same-UID process can replace any
owner-writable file — including a launch descriptor and its checksum
sidecar. Preventing that requires a separate OS identity, privileged
immutable storage, or a signing secret inaccessible to that UID, and is
**out of scope**.

Team-up does **not** pretend otherwise. Canonical descriptors outside
ordinary worker-visible paths, checksum validation, fail-closed adapter
requirements, and read-only sandbox binds protect **normal harness tool
use and accidental mutation**. They do **not** stop hostile same-UID
filesystem tampering.

Token targets are **advisory** only — see budget normalization.
Legacy config booleans such as `mediated_commands: true` or
`token_budget_adapter: true` are ignored. Until a command-broker adapter is
verified:

- non-empty `permissions.commands` or `command.*` / `shell.*` / `exec.*`
  tools → `ALLOWLIST_UNENFORCEABLE` (pre-broker gate)

Starter manifests declare the designed capabilities (including Tessa
`command.test` / `project-test` and advisory token targets). Only Claude can
earn the context-isolation grant today (see `docs/capabilities.md`, "Harness
contract"); Codex declares none, OpenCode has no `harness verify` runner, and
Cursor / Hermes have no adapter, so specialists run on Claude only.

### Capability recommendations and pool

Specialist manifests may declare inert `recommendations` metadata:

```json
"recommendations": [{
  "package": "style.caveman",
  "source": "https://github.com/example/caveman.git",
  "reason": "Reduces routine output",
  "suggested_target": "research.reanna"
}]
```

Recommendations never preselect or activate packages. Effective pool set for
specialist `S`:

```text
intrinsic specialist package
+ assignments targeted to all or S
- assignments explicitly excluding S
```

There is no mandatory shared baseline: a package reaches a specialist only
through an assignment a human made. Capsules materialize only the effective
set under `context/` and `harness/`, with `EFFECTIVE_CAPABILITIES.json` as the
audit record. Before materializing, the launcher recomputes each package's
checksum from the pool and refuses `CAPABILITY_TAMPERED` if the files changed
since install.

### Three skill layers

The host session (the main agent the human talks to) and the specialists see
different skills on purpose. A capsule never reads the host's `~/.claude`, so
a skill installed only there is already invisible to every specialist. That
rests on two things: the worker's `HOME` is the run's auth-only home, and it
launches with `--setting-sources user`. The second matters because a run's cwd
sits under the real home, and Claude otherwise reads `.claude/skills` and
`CLAUDE.md` from every directory above its cwd. From 2026-09-01 until this
was fixed every capsule listed the host's skills that way, and every
transcript that records instructions (2.1.284 on) shows the host's
`CLAUDE.md` files loaded too.
The isolation canary plants an ancestor skill and `CLAUDE.md` to keep it from
coming back.

| Layer | Who sees it | How it gets there | Examples |
|---|---|---|---|
| `main` | host only | host install, or pool `--for host` | memory MCP skills, `dispatch`, `pipeline`, `intake`, `team-up-manage` |
| `shared` | host and specialists | pool `--for all` **and** `--for host` | `style.caveman` |
| `specialist` | specialists only | specialist bundle skills, or pool `--for <id>` | `ponytail.build`, `code-review` |

`host` is an assignment target like `all`, and independent of it: `all`
means every specialist, never the host. Enabling a package `--for host`
symlinks each of its skill directories from the pool into the host skill
directory (`~/.claude/skills`, or the `TEAM_UP_HOST_SKILL_ROOTS` list), so the
host and the specialists run the same bytes under one checksum instead of two
copies drifting apart. The link points host → pool, never the reverse: the
pool copy stays the one the checksum covers, and its files are made read-only
when linked. Only skills can be linked (`HOST_LINK_UNSUPPORTED` otherwise),
and an existing host entry that is not a team-up link is never replaced
(`HOST_SKILL_COLLISION`, nothing recorded). Disable `--for host` removes the
link; rollback moves it.

A skill declares its layer in frontmatter, under the Agent Skills `metadata`
map; a package may also set `"scope"` in `capability.json`. The two must
agree.

```yaml
---
name: intake
description: ...
metadata:
  team-up-scope: main
---
```

- `main` packages can only be enabled `--for host` (`CAPABILITY_SCOPE_MAIN`),
  are refused at capsule build whatever the assignment file says, and cannot
  ship inside a specialist bundle.
- `specialist` packages cannot be enabled `--for host`
  (`CAPABILITY_SCOPE_SPECIALIST`).
- Unscoped packages keep the old behaviour.

A bundle's own skills ship as flat `skills/<name>.md`. Harnesses register
only skill directories, so the materializer copies each one a second time as
`context/skills/<name>/SKILL.md`, with `name` and a `description` taken from
the first paragraph after the title (unless the file already has
frontmatter). A bundle may also carry a `LICENSE` file at its root.

### Skills the launcher invokes

A package may name one of its skills in `"auto_invoke"`. When that package is
in a specialist's effective set, the launcher opens the worker prompt with the
harness's own invocation of it — `/caveman` in Claude Code — ahead of the
mailbox protocol and the task. The task then arrives as the skill's
arguments. This is deterministic: it does not depend on the host agent
remembering to ask for it. Invoked as the first user turn, the skill sits right
before the task; the same text as an output style sits in the system prompt,
and in use changed the output far less.

At most one skill per launch can open the prompt; two packages that both ask
fail the run with `AUTO_INVOKE_CONFLICT`. A harness with no invocation syntax
in its adapter gets no prefix, and `STATE.json` records
`auto_invoke.applied: false` with the reason rather than a guessed syntax.

```bash
team-up capability scan --root ~/.claude
team-up capability install ./pkg
team-up capability install https://github.com/example/x.git --git-ref v1.2.0
team-up capability enable pkg@1.2.0 --checksum sha256:... --for all
team-up capability enable pkg@1.2.0 --checksum sha256:... --for host
team-up capability disable pkg@1.2.0 --checksum sha256:... --for research.reanna
team-up capability update pkg --git-ref main
team-up capability rollback pkg@2 --to 1 --checksum sha256:new --prior-checksum sha256:old
team-up capability remove pkg@1 --checksum sha256:...
```

Home-installed CLIs need a **non-empty** `sandbox.runtime_paths` list when
OS isolation is actually applied.
`runtime_paths: []` is treated as not configured →
`SANDBOX_RUNTIME_UNAVAILABLE`.

## Starters

`catalogue.json` at the repo root lists every published specialist and every
capability package here: id, version, repo, call types, the permissions it
asks for, and what it needs from the project. Read the permissions before the
repo URL — that is what decides whether you want to run someone else's
specialist at all.

It is a hand-maintained list, not a registry. Nothing resolves it at runtime
and installing is unchanged:

```bash
git clone https://github.com/Bumblebiber/team-up-with-<name>
team-up specialist inspect ./team-up-with-<name>
team-up specialist install ./team-up-with-<name>
```

The half of the list that lives in this repo — the capability packages — is
checked against its manifests by `test/catalogue.test.mjs`. The specialist
half is not: those bundles are separate repos, so a version there can move
without this file noticing.
