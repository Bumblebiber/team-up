# Specialists

One repository = one specialist. Packages contain `specialist.json`,
instructions, skills, and evals — never concrete model/provider names or
executable install hooks.

## Lifecycle

```bash
team-up specialist inspect <path>
team-up specialist install <path>
team-up specialist approve <id>@<version> --project <abs-path> [--clone-root <abs-path>]
team-up specialist pin <id>@<version> [--project <abs-path>]
team-up specialist uninstall <id>@<version>
team-up specialist list
team-up specialist run --id <id> --call-type review --objective "..." --project <abs> [--cli <cli>] [--model <model>]
```

Approval binds project + id + version + checksum + permissions. Any checksum
or permission change requires reapproval. The project is the directory the
filesystem reports, not the spelling: a symlink and its target are one project
and share one grant.

`--clone-root` widens only the path half of that binding. A `pipeline` fan-out
gives each parallel writer its own full clone, so an exact-path grant means one
permission prompt per disposable directory. With a root, one grant covers every
clone under it:

```bash
team-up specialist approve coding.codey@0.1.2 \
  --project ~/projects/team-up --clone-root ~/projects/tasks
```

Everything else is still measured at `--project` and still has to match at
launch: package checksum, permissions, and the project command policy. A clone
carrying a different policy is refused exactly as an unapproved project is, and
a path that only looks like it is under the root — a symlink pointing out of it,
or a `..` — is outside it. The root itself is never covered; it is the container
the clones sit in, not a project. A root that does not exist, that is `/` or the
home directory, or that contains `--project` is refused outright. Beyond that,
name a root that holds nothing but disposable clones: within those limits, a
root grant does say "anywhere under here".

Installing a second version never repoints an existing selection — that would
silently change what runs. `pin` is how the selection moves, and it is a
separate step on purpose: approve the new version first, then pin it. Without
`--project` the pin is global; with it, only that project sees the new version
and everywhere else keeps the old one. `run` has no `--version` flag; the pin
is the single place a version gets chosen.

`--cli` and `--model` override the cell for one run. The named model's own tier
replaces the one the specialist's profile asks for — that demand is the standard
being overridden — and the resolved chain is then narrowed to that cell.
Everything else still gates it: account, harness capability (context isolation,
command broker) and usage windows are unchanged, so an override can only pick a
cell the gates already allowed. A named cell that no gate let through is refused
with `RUNTIME_OVERRIDE_UNAVAILABLE` and the reason it was dropped, never
silently swapped for another model.

`uninstall` removes one version: its package tree, its index entry, any pin
naming it, and any approval bound to it. It refuses while an unfinished run
still depends on that version — a resume re-verifies the package checksum, so
removing it early turns into an integrity failure later instead of an error
now. It also refuses to remove the selected version while siblings remain, for
the same reason install never repoints a selection: pin the replacement first.
Removing the last version drops the id entirely.

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
trusted, approved specialists — not a security boundary. The launcher always
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
actions live in `.team-up/commands.json`, are checksum-bound on specialist
approval, and are snapshotted under `~/.team-up/policy-snapshots/<runId>/`
outside every worker-writable path. The MCP broker validates that approval
checksum before each action and never re-reads a worker-modifiable copy.
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

Starter manifests declare the approved design capabilities (including Tessa
`command.test` / `project-test` and advisory token targets). Claude and Codex
have context-isolation adapters; Cursor / Hermes / OpenCode remain unsupported
until each has a live verified implementation.

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
a skill installed only there is already invisible to every specialist.

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
