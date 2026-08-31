---
name: pipeline
description: "The shape of a multi-specialist change and the invariants that keep it correct. Use when orchestrating more than one specialist on one piece of work — spec to tickets to parallel writers to a merged review — or when deciding whether a piece of work should be split at all. Covers clone-per-writer, review-once-on-the-merged-result, who may write to memory, and how deep a chain may nest. Not the mechanics of a single spawn: see the dispatch skill for those."
---

# pipeline — How a change moves through specialists

The `dispatch` skill covers one spawn. This one covers what a spawn is part of,
and the rules that stop a fan-out from producing work that is individually
correct and collectively broken.

You are the Overseer: the session the human is talking to. You are also the
orchestrator. Nothing below is delegated to a specialist.

## The shape

    Human ⇄ Overseer      grill · spec · tickets · dispatch · merge · memory
                ↓
            writers × N   one full clone per ticket, in parallel
                ↓
            reviewer      once, on the merged result

Six stages, and the first two never leave your session:

1. **Grill.** Ask until the request stops changing. The value is in what the
   human corrects between answers, so this cannot be handed to a specialist —
   it does not serialise into a request field.
2. **Spec.** You write it, because you have the conversation behind it.
3. **Tickets.** Cut the spec into pieces that can be done independently.
   What each piece must carry is an invariant below.
4. **Dispatch.** One writer per ticket, in parallel, each in its own clone.
5. **Merge.** Yours. You have the real tree and you are the only one who can
   ask the human about a conflict.
6. **Review.** Once, on the merged result.

Stages 4–6 are worth their overhead only when the tickets are genuinely
independent. One agent beats three when the subtasks share context — see
`dispatch`, which says the same thing about subagents. A change that is one
edit is one edit.

## Invariants

These are not style preferences. Each one is here because the alternative was
measured and lost something.

### One full `git clone` per parallel writer

Not a shared tree: two processes editing the same line in one tree lose an edit
silently, and both report success.

Not a `git worktree`, and not `git clone --shared`. Both leave `.git` as a
pointer to objects outside the tree — a worktree through its `.git` file, a
shared clone through `objects/info/alternates`. A writer confined to its own
directory cannot follow either pointer, so git stops working inside it.

A full clone is self-contained and disposable. That is what makes it safe to
let a writer use git freely inside one.

### A ticket carries its contract, not its coordinates

A file path and a line range written into a ticket describe the tree as it
stood when the ticket was cut. The writer's own first edit invalidates them
inside its own clone; a blocking ticket invalidates them before the writer
starts. A writer that trusts a stale coordinate does not stall on it — it
edits the wrong place and reports success, and the cost lands in a review
cycle.

So a ticket carries what stays true across all of that:

- **The seam** it is verified at, named from the spec. Not "add tests".
- **Consumes / Produces** — what it relies on from its blockers and what its
  dependents rely on from it, as exact names and types.
- **The constraints** that bind it — version floors, dependency limits,
  naming rules — copied verbatim from the spec rather than paraphrased.
- **Acceptance criteria**, and the behaviour they check, from the user's side.
- **The non-goals** — the neighbouring defects a competent implementer would
  otherwise fold in. A writer that finds a second bug while fixing the first
  will fix both unless the ticket says not to, and that is how one slice turns
  into a diff the reviewer cannot judge.

It does not carry exact file paths, line ranges, or implementation code.

Consumes/Produces does the work that reading the code would otherwise do. A
writer sees only its own ticket, so this block is the only place it learns the
names its neighbours expect; and for a ticket behind a blocker there is no
post-blocker tree to read at cutting time, so the contract has to be declared
rather than discovered.

None of this is licence to cut a thin ticket. A writer that has to pick the
seam and design the test itself produces worse work than one handed the
contract — at the same model, on the same slice. The detail is what closes
that gap. Putting it in the ticket costs nothing extra: cutting tickets
already means reading the codebase once, with the context loaded. Re-deriving
it per ticket pays that read again for every ticket.

### The reviewer runs once, on the merged result

Per-ticket review cannot see the defect class that matters here: two diffs,
each correct alone, broken together. A cheap self-check inside a writer is
fine as a pre-filter. The authoritative pass runs after the merge.

Give the reviewer a fresh session and do **not** pass it the plan. A reviewer
that has read the reasoning behind a change reviews the reasoning, not the
change.

### Only the Overseer writes to memory

No specialist gets the memory MCP — not read, not write. Three reasons:

- Parallel writers could not do it anyway: one project bind per session means
  three writers either collide or overwrite each other.
- Cost. A memory server is ~140 tools handed to an agent whose whole value is
  being narrow.
- Whoever writes to memory decides what is remembered as true. A wrong
  attribution in a mailbox report is something you catch while reading. In
  memory it is a false entry someone reads as fact six months later.

Context flows into a specialist as data, in the request's `inputs` field. You
put the relevant excerpt there. This is enforced by construction:
`--strict-mcp-config` takes only what the descriptor names, so a descriptor
with no memory server is a capsule with no memory server.

The mailbox is already the durable record — `RESULT.json`, `STATE.json` and
`audit/commands.jsonl` per run. Memory is the curated layer on top, not a
second copy of the raw one.

### A writer's write scope is a promise, not a fence

Measured on claude 2.1.250: a path specifier on `Write` does not scope
anything. `Write(//abs/path/**)` in `permissions.allow` denies a write *inside*
that path; bare `Write` grants everything. A `Write(...)` deny rule with a path
does not match either. Path rules work for `Read` and not for `Write`.

So a writer holds an unbounded `Write`. What actually contains it is the
disposable clone plus the instruction to stay in it, and the OS sandbox on
hosts where it engages. Decide what you hand out on that basis: a writer can
write outside its remit, and only the prompt tells it not to.

### Depth is capped at 3

`normalizeRequest` rejects a request past `MAX_DEPTH`. The cap exists so a
writer→reviewer→writer ping-pong terminates. If you find yourself on cycle
three, the ticket is wrong — go back to the spec rather than around again.

## Orchestrate always, integrate while it is trivial

Dispatching, tracking state and collecting results are bookkeeping, and they
stay with you however large the fan-out gets. A real merge conflict that needs
a test run is code work: cut a ticket and hand it out.

## What survives your session

Run state lives on disk, so the session is replaceable: `runs resume` recovers
in-flight runs, a resume lock steals from a dead PID, and host-crash recovery
reads `STATE.json` rather than re-dispatching.

What does *not* survive is the memory write. If this session dies between a
result landing in the mailbox and you recording it, the result sits there and
nobody lifts it. Until a sweep exists for that, write the memory entry when the
result arrives — not at the end of the batch.
