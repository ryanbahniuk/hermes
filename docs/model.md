# Hermes — the mental model

Read this first. It explains the handful of concepts Hermes is built from and how they nest,
so the CLI and the docs make sense. (For the deep design, see
[`architecture.md`](./architecture.md).)

## The one-sentence version

You **chat** with a planner; when the plan is clear it **delegates** batches of work; each batch
**fans out** to one worker per repo. Three nested layers: **Session → Run → Task**.

```
Session   (a conversation with the planner — the primary interface)
  └─ Run     (one "go do this batch of coordinated edits now")
       └─ Task   (one project's slice of that batch: a worktree + a worker agent)
```

## The concepts

### Project
A locally checked-out git repo you've registered in `hermes.config.ts` as
`{ name, path, description }`. The `description` is load-bearing — the planner reads it to decide
which repos a piece of work touches. Projects are the fixed universe Hermes operates over;
everything else below is created at runtime.

### Session — the conversation
An ongoing, **resumable chat with a planner agent**. This is the front door (`hermes chat`, or
just `hermes`). The planner's job is to **clarify and delegate — it never edits code**. It can
read your projects (read-only) to ask good questions, and it dispatches work by calling its
`delegate` tool. A session is a foreground process while you're in it; its transcript, resume
handle, and cost persist so you can leave and `--resume` later.

Think of a session as *a line of thinking about some goal*, not a single command.

### Run — a batch of work
One **problem statement fanned out across the relevant projects**, coordinated by one shared
contract and reconciled together. A run is what `hermes run "…"` creates directly, and it's also
exactly what the planner's `delegate` produces. Each run is owned by a **detached background
supervisor** that survives your terminal closing.

A run has a lifecycle: `plan → implement (parallel) → adjudicate → reconcile → done`. Because a
run is fanned out *once* and reconciled *once*, "do X, then based on the result do Y" is **two
runs**, not one.

### Task — one repo's slice
One project's part of a run: an **isolated git worktree + a single worker agent** doing the edits
there. Tasks in a run run **in parallel**, each in its own worktree, so they never clobber each
other. A task is the leaf — it's where code actually changes and where cost is ultimately
incurred.

### Shared context (the contract)
A per-run, versioned artifact the planner authors: the cross-project agreement (interfaces,
naming, shapes) every worker in that run must conform to, so independent parallel edits stay
consistent. Workers read it; if one thinks it's wrong it calls `propose_amendment` (rare), which
the supervisor adjudicates live.

### Planner vs. worker (two tiers, on purpose)
| | Planner | Worker |
|---|---|---|
| Runs in | the session (foreground, one long-lived context) | a task (background, ephemeral) |
| Can write code? | **No** — read-only + `delegate` | **Yes** — inside its worktree only |
| How many | one per session | one per project per run (many, parallel) |
| Typical model | powerful/expensive | can be cheaper |

The split is the whole point: keep the expensive model on *thinking*, hand the *doing* to a swarm.

### Runtimes (how any of them actually runs a model)
Both planner and workers are **model-agnostic** over two runtimes: `claude` (Claude Agent SDK)
and `hermes` (LangGraph over Bedrock Converse, for any non-Anthropic model). You pick models in
config; Hermes selects the runtime per model. Same two-runtime split for the planner as for
workers.

## How they relate (cardinality)

```
Project (fixed, from config)
Session 1 ──< Run 0..* ──< Task 1..*
              │
              └─ each Run: 1 shared_context (versioned) + 0..* amendments
```

- A session dispatches **zero or more** runs (often just one; more when you keep iterating).
- A run has **one or more** tasks (one per selected project).
- A run can also exist with **no session** — `hermes run` used directly. `runs.session_id` is
  the nullable link back to the conversation that spawned it.

## A worked example

Session: *"add idempotency keys to our payments API"* (projects: `schemas`, `api`, `web`,
`mobile`).

1. **Turns 1–4** — you and the planner talk. It reads `api`/`schemas`, asks about header vs. body,
   retention, whether refunds are included. No runs yet.
2. Plan is clear → planner calls `delegate` → **Run A**:
   ```
   Run A  "idempotency support on payments create/refund"
     ├─ Task schemas → add idempotency_key to the proto
     └─ Task api     → enforce + dedupe on the key
     contract: "header Idempotency-Key; 24h retention; 409 on replay"
   ```
3. You review Run A's diffs (`hermes show <run>`), merge it.
4. **Same session**, next turn: "now make the clients send the key" → **Run B**:
   ```
   Run B  "send Idempotency-Key from the clients"
     ├─ Task web    → send header from checkout
     └─ Task mobile → same in the SDK
   ```

Resulting tree:
```
session (idempotency conversation)
 ├─ Run A ─┬─ Task schemas
 │         └─ Task api
 └─ Run B ─┬─ Task web
           └─ Task mobile
```
B is a **separate run** because it depends on A being merged, has a different contract, and you
wanted to review A first. Had you said "do it all end-to-end" up front, it would have been one
run with four tasks.

## Cost

Cost is produced at the leaves (tasks) and aggregates upward:

- **Task** — cost of that worker's model usage.
- **Run** — sum of its tasks.
- **Session** — the planning conversation **plus** the aggregate cost of every task across every
  run it dispatched. Shown as `total (planning $X + work $Y)`. This total is computed on read
  (summing task costs), so it stays accurate as background runs finish.

## Where state lives

- **Config** (`hermes.config.ts`) — the fixed registries: projects, models, read allowlist.
- **SQLite** (`~/.hermes/hermes.db`) — sessions + transcripts, runs, tasks, shared context,
  amendments.
- **Worktrees** (`~/.hermes/worktrees/<run>/<project>`) — where workers make changes; kept for
  you to review and merge.
- **Logs** (`~/.hermes/logs/<run>/`) — per-run / per-task output.

## Quick command map

| You want to… | Command |
|---|---|
| Start / resume the primary interface | `hermes` · `hermes chat` · `hermes chat --resume <id>` |
| See your conversations | `hermes sessions` |
| Dispatch a batch directly (skip the chat) | `hermes run "…" [--projects a,b]` |
| Inspect a batch | `hermes runs` · `hermes ps <run>` · `hermes show <run>` |
| Watch work happen | `hermes logs <run> -f` · `hermes watch` |
| Control a batch | `hermes stop <run>` · `hermes resume <run>` |
