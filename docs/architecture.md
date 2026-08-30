# Tack — Architecture

Tack is a personal, local development harness. You hand it a **problem statement**;
it decides which of your locally checked-out projects are relevant, spins up an
isolated git worktree in each, and dispatches background agents (any model on AWS
Bedrock) to work the problem in parallel — coordinating them through a shared
contract so changes across repos stay consistent.

It is a CLI, it runs on Bun, and it is genuinely model-agnostic: any Bedrock
foundation model can be an agent, Anthropic or not.

---

## Goals & non-goals

**Goals**
- Project-agnostic kickoff: one problem, many repos, chosen automatically.
- Model-agnostic over Bedrock — **any** model (Claude, Llama, Mistral, Nova, …), with the
  planner and implementers free to be different models.
- Optional first-party backend: Anthropic models may run via the Anthropic API instead of
  Bedrock, as an opt-in per-model choice (Bedrock stays the default).
- Background agents that survive the terminal closing and run in parallel.
- Cross-project coordination via a shared context/contract, with live iteration.
- Filesystem isolation so parallel agents never clobber each other.
- Modern TS tooling throughout.

**Non-goals (for now)**
- Multi-user / remote execution (local single-user only).
- A hard security sandbox around `shell` (see [Tool surface](#agent-tool-surface)).
- A persistent always-on daemon (supervisors are per-run and exit when done).
- Perfectly identical agent behavior across the two runtimes (see the runtime trade-off).

---

## Tech stack (locked decisions)

| Concern | Choice | Notes |
|---|---|---|
| Runtime / package manager / bundler | **Bun** | `bun build --compile` for distribution later |
| Language | **TypeScript** | |
| Orchestration | **Plain Tack TS** in the supervisor process | not a graph framework — explicit control flow |
| Agent runtime (Anthropic models) | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) | reuses its tools, permissions, subagents, session resume |
| Agent runtime (non-Anthropic models) | **LangGraph TS** `createReactAgent` + **`@langchain/aws` `ChatBedrockConverse`** | our tools + SQLite checkpointer |
| Runtime selection | **`AgentRuntime` interface** | supervisor picks per task from the model registry |
| Persistence (run state) | **`bun:sqlite`** | our tables: runs, tasks, shared_context, amendments |
| Persistence (agent state) | **per-runtime** | SDK sessions (`claude`) / LangGraph checkpointer over `bun:sqlite` (`tack`) |

> **Reversal (implementation):** we originally chose `better-sqlite3` everywhere so the
> official LangGraph SQLite checkpointer would work unmodified. In practice
> `better-sqlite3@13`'s native N-API bindings **crash Bun 1.3.14** on open
> (`NAPI FATAL ERROR`). We switched run-state persistence to Bun's built-in `bun:sqlite`
> (zero native addon, works cleanly). Consequence for step 6: the `tack` runtime needs a
> **custom checkpointer over `bun:sqlite`** rather than the official `better-sqlite3` one.
| Background execution | **detached supervisor process per run** | survives CLI exit; resumable |
| Isolation | **git worktree per project** | filesystem isolation |
| CLI | **citty** + **Ink** (dashboard) + **@clack/prompts** + **picocolors** | |
| Config | **typed `tack.config.ts`** | project registry + model registry + read allowlist |

**The Option-C trade-off (accepted):** two agent runtimes means agent *behavior* isn't
byte-identical across models — different tool implementations and quirks. We minimize the
divergence with (1) shared Tack coordination tools, (2) one common scoping/permission
config, (3) a normalized event/cost shape. For a personal harness this is a fine trade for
true any-model support.

---

## Core concepts

- **Project** — a locally checked-out repo Tack may use. Registered in config with
  `{ name, path, description }`. The `description` is load-bearing: the planner reasons over
  it to select relevant projects.
- **Run** — one problem statement and everything spawned to solve it. Carries the planner
  `model` and a rolled-up `cost`.
- **Task** — one project's slice of a run: a worktree + an implementation agent, run through
  a chosen `AgentRuntime`.
- **Supervisor** — the detached process that owns a run end-to-end (plan → fan-out →
  adjudicate → reconcile), written as plain TS control flow.
- **Agent runtime** — a pluggable engine that actually runs an agent. Two implementations:
  `ClaudeRuntime` and `TackRuntime` (LangGraph). Selected per task by model.
- **Shared context** — a versioned, run-level artifact (the agreed contract / cross-project
  interface). Authored by the planner, read by every implementer, enforced at reconcile.
- **Model registry** — `{ name, version, provider, runtime, inferenceProfile, awsProfile? }` entries.

---

## Agent runtime layer

The heart of Option C. The supervisor never talks to a model directly — it talks to an
`AgentRuntime`, and picks the implementation from the task's model registry entry.

```
interface AgentRuntime {
  run(task: AgentTask): AsyncIterable<AgentEvent>      // stream tool calls, tokens, result
  resume(taskId: string): AsyncIterable<AgentEvent>    // crash recovery
}

AgentTask = {
  prompt, cwd (= worktree path), model,
  sharedContextRef,                    // current contract version to read
  scoping: { worktree, readAllowlist },// enforced by both runtimes
  tools: TackToolset,
}

AgentEvent = log | tool_call | usage(costTokens)
           | amendment_proposed | done(summary, diffRef) | error
```

Both runtimes normalize to `AgentEvent`, so logging, cost rollup, and the supervisor are
runtime-agnostic.

### Two implementations

**`ClaudeRuntime`** (Anthropic models) — wraps the Claude Agent SDK. Reuses the SDK's
native tools and permission system; we only add Tack coordination tools and enforce scoping
via hooks. Supports two backends, chosen per model (see [registry](#model-layer--registry)):
- `bedrock` (default) — `CLAUDE_CODE_USE_BEDROCK=1` + AWS creds; model = inference profile.
- `anthropic` — first-party Anthropic API; `ANTHROPIC_API_KEY` from env; model = `apiModelId`.

**`TackRuntime`** (any other Bedrock model) — a LangGraph `createReactAgent` driven by
`ChatBedrockConverse`, with our own worktree-scoped tools and the `better-sqlite3`
checkpointer for resume.

### How the two satisfy one contract

| Capability | `TackRuntime` (LangGraph) | `ClaudeRuntime` (Agent SDK) |
|---|---|---|
| read (worktree ∪ allowlist) | our LangChain tool, path-checked | SDK **Read** + `PreToolUse` hook path check |
| write / edit (worktree only) | our tools | SDK **Write/Edit** + permission deny outside worktree |
| search | our ripgrep tool | SDK **Grep/Glob** |
| shell (cwd = worktree) | our tool | SDK **Bash** |
| git (worktree only) | our tool | SDK **Bash** (git) |
| `read_shared_context` | **Tack tool (shared, identical effect)** | **Tack in-process tool (shared)** |
| `propose_amendment` | **Tack tool (shared)** | **Tack in-process tool (shared)** |
| agent-state resume | LangGraph checkpointer (thread = taskId) | SDK session (`resume_ref` = session id) |

The **coordination tools** (`read_shared_context`, `propose_amendment`) are the one place we
inject the *same* Tack-authored tool into both runtimes, so cross-project coordination
behaves identically regardless of model.

---

## Planning sessions (the primary interface)

The front door to Tack is an **interactive planning session**, not a one-shot command. You
converse with a **planner agent** whose sole job is to clarify requirements and **delegate** —
it never edits code. This keeps the powerful, expensive model on planning and hands the actual
work to a swarm of (possibly cheaper) workers.

```
tack session start   (foreground; `tack` with no subcommand does the same)
   │  PlannerSession: one persisted `sessions` row + one long-lived PlannerRuntime instance
   │
   ├─ turn ↔ turn conversation with the user (transcript persisted to `session_messages`)
   │
   ├─ tools available to the planner:
   │    · list_projects / read_file / search / list_dir  — read-only investigation
   │    · delegate(problem[, projects, sharedContext])    — dispatch a worker swarm
   │    · check_runs                                       — report swarm progress
   │
   └─ delegate → createRun (tagged session_id) + optional pre-created tasks + spawnSupervisor
                  → the detached supervisor path (the only way work is kicked off)
```

- **Model-agnostic like the workers.** The planner is a `PlannerRuntime` with two
  implementations mirroring the `AgentRuntime` split: `claude` (Claude Agent SDK, resumed per
  turn via the SDK session id) and `tack` (LangGraph react agent; conversation state kept as
  an in-process message list, seeded from the persisted transcript on resume). `selectPlannerRuntime`
  picks by the planner model's runtime.
- **Read-only by construction.** The planner's filesystem scope spans every configured project
  root + the read allowlist, with *no* writable worktree. The `claude` planner denies
  Write/Edit/Bash via a `PreToolUse` hook (reads are path-checked); the `tack` planner is
  simply given only read tools. Work happens only through `delegate`.
- **Delegation is the only entry point.** `delegate` drives the run/supervisor/worker machinery;
  a delegated run carries a `session_id` tag. There is no public CLI command to start a run — a
  session is the sole way to kick off work. The planner may name projects + per-project subtasks
  explicitly (it has conversation context) or omit them and let the supervisor's own planner select.
- **Persisted + resumable.** Sessions, their transcripts, resume handle, and rolled-up cost live
  in SQLite. `tack session start --resume <id>` reopens the conversation; `tack session list` lists them.

## Execution model

`delegate` returns instantly with a run ID; everything real happens in a **detached
supervisor process, one per run**, that survives the terminal closing and exits when the run
finishes.

```
delegate("problem")  ──────────────────────────────►  returns run ID immediately
   │
   └─ detached SUPERVISOR PROCESS (one per run) — plain-TS orchestrator
        │
        ├─ PLAN        powerful model (its runtime, read-only): select projects from the
        │              registry descriptions + author shared-context v1 (the contract).
        │              Backgrounded and may be stronger than the implementers it delegates to.
        │
        ├─ FAN-OUT     create a git worktree per selected project → one task each
        │
        ├─ IMPL ×N     parallel. Each task runs via the AgentRuntime chosen from its model:
        │   (parallel)   Claude model → ClaudeRuntime · other model → TackRuntime.
        │                Each reads shared context; may call propose_amendment.
        │
        ├─ ADJUDICATE  powerful model resolves amendment proposals: accept → version-bump
        │              shared context + notify affected in-flight agents; reject → conform.
        │
        └─ RECONCILE   collect diffs, check against the final contract, spawn fix-ups,
                       mark the run done.
```

**Why one supervisor process, not N agent subprocesses:**
- Shared context and orchestration state stay in one place (the supervisor + SQLite).
- The supervisor is alive to adjudicate and reconcile — nothing orphans.
- Parallelism still holds: agent work is I/O-bound on Bedrock; `shell`/`git` are real OS
  subprocesses via `Bun.spawn`.
- Resilience is explicit: orchestration progress is persisted in SQLite, and each agent's
  conversation resumes via its runtime. `tack run retry <run>` replays.
- Still "background": the detached property holds at the *run* level.

Worktrees provide **filesystem** isolation; we deliberately drop per-agent **process**
isolation in favor of one supervisor + resume.

---

## Process lifecycle & management

There is **no always-on `tack` daemon** — zero background footprint when idle. Instead,
**one ephemeral supervisor process per active run**, which self-terminates when the run ends.

```
delegate("fix the thing")   ← from a planning session
   │  write a run row to SQLite, spawn a DETACHED child, return run ID.
   ▼
   bun bin/supervisor.ts <runId>     ← detached background process
      • own session (setsid) → closing the terminal doesn't kill it
      • stdout/stderr → per-run log file (not your terminal)
      • parent unref()'d it → CLI exits without waiting
      • runs the orchestration, then EXITS on its own
```

Management commands are all **short-lived CLI invocations over SQLite + signals** — none stay
resident:

| Command | Behavior |
|---|---|
| `tack run list` / `tack task list` | Read SQLite; pid-liveness-check the supervisor → show **running** vs **crashed/stalled**. |
| `tack run logs <run> -f` | Tail the per-run log file. |
| `tack run stop <run>` | Read `supervisor_pid`, send SIGTERM. |
| `tack run retry <run>` | Respawn a supervisor; skip done tasks, resume in-flight ones from their runtime state. |
| `tack session show <session>` | Print the session's Run → Task tree (top-down view). |

**Terminal close vs. reboot:** detaching (new session + unref) means closing your terminal or
shell does **not** kill a run; a machine reboot **does** (these are plain processes, not a
launchd service). After a reboot, mid-flight runs sit in SQLite with a dead pid; `tack run list`
flags them stalled and `tack retry` picks them up. Auto-resume-on-boot is a later opt-in
(wrap retry in a launchd agent).

---

## Coordination & shared context (live iteration, planner-authoritative)

Chosen model: **(b) iterative**, but the planner is trusted by default.

1. **Author** — PLAN writes shared-context v1: the contract, cross-project interfaces, shared
   decisions.
2. **Distribute** — every implementer reads the current shared context (via the
   `read_shared_context` tool). This is what lets weaker implementers coordinate.
3. **Propose (not mutate)** — an implementer that believes the contract is wrong calls
   `propose_amendment`; it never edits shared context directly. High bar — most agents conform.
4. **Adjudicate** — the proposal routes to the supervisor's ADJUDICATE step (powerful model),
   which **accepts** (bump shared-context version, notify affected in-flight agents — they
   re-read at their next step boundary) or **rejects** (instruct the proposer to conform).
5. **Reconcile** — final diffs are checked against the final contract version; divergences
   trigger fix-up passes.

Shared context is **versioned**; agents check the version at step boundaries so an accepted
amendment propagates without chaotic mid-tool-call interruption.

---

## Agent tool surface

Each implementation agent is scoped to its worktree. Canonical capability contract (each
runtime satisfies it per the [runtime table](#how-the-two-satisfy-one-contract)):

- `read` — read files. Enforces `path ∈ (worktree ∪ readAllowlist)`.
- `write` / `edit` — worktree only.
- `search` — ripgrep, worktree only.
- `shell` — run commands (cwd = worktree).
- `git` — worktree only.
- `read_shared_context` / `propose_amendment` — Tack coordination tools, identical in both
  runtimes.

**Read allowlist:** a configured list of directories the read tool may also read (read-only).
Caveat: `shell` runs as your OS user and can read anything — so the allowlist is a hard
boundary on the *read tool*, not on `shell`. `shell` is trusted by design in v1.

---

## Data model

**Source of truth for registries is the config file** (`tack.config.ts`) — projects, models,
allowlist. **SQLite holds runtime/run state.** Agent conversation state lives per-runtime.

```
runs
  id            text  pk
  problem       text
  status        text  -- planning | implementing | coordinating | reconciling | done | failed
  planner_model text
  cost          real  -- rolled up: planner + all tasks
  supervisor_pid integer
  created_at, updated_at

tasks
  id            text  pk
  run_id        text  fk -> runs.id
  project_name  text
  worktree_path text
  status        text  -- pending | implementing | proposing | paused | reconciling | done | failed
  model         text
  runtime       text  -- 'claude' | 'tack'
  resume_ref    text  -- SDK session id | LangGraph checkpoint thread id
  cost          real
  diff_ref      text  -- pointer to captured diff/patch
  created_at, updated_at

shared_context
  run_id        text  fk -> runs.id
  version       integer
  content       text
  authored_by   text  -- 'planner' | task_id (via accepted amendment)
  created_at
  primary key (run_id, version)

amendments
  id            text  pk
  run_id        text  fk -> runs.id
  proposed_by   text  fk -> tasks.id
  proposal      text
  status        text  -- proposed | accepted | rejected
  resolution    text  -- adjudicator note
  created_at, resolved_at

sessions                    -- planning conversations (the primary interface)
  id            text  pk
  title         text        -- derived from the first user message
  planner_model text
  runtime       text        -- 'claude' | 'tack'
  resume_ref    text        -- claude SDK session id (null for tack)
  status        text        -- active | closed
  cost          real        -- planner-conversation cost only; the session TOTAL
                            --   (planner + every delegated task's cost) is derived
                            --   on read by sessionTotalCost, never stored, so
                            --   background runs stay authoritative for their cost
  created_at, updated_at

session_messages            -- persisted transcript, for resume + replay
  id            text  pk
  session_id    text  fk -> sessions.id
  role          text        -- user | assistant
  content       text
  created_at

runs.session_id  text       -- nullable; links a delegated swarm back to its session

-- plus LangGraph checkpoint tables (better-sqlite3), used only by TackRuntime tasks
```

---

## Model layer & registry

- **Registry entries:** `{ name, version, provider, runtime, backend, ...target }`.
  - `provider` — e.g. `anthropic` | `meta` | `mistral` | `amazon` | …
  - `runtime` — `claude` for Anthropic, `tack` otherwise (inferred from provider,
    overridable — e.g. run Claude through `tack` for uniform tooling).
  - `backend` — `bedrock` (default) | `anthropic`. `anthropic` is valid **only** for
    `provider: anthropic` + `runtime: claude`. `tack` and all non-Anthropic providers
    ⇒ `bedrock` only.
  - **target id** (depends on backend): `inferenceProfile` for `bedrock`, `apiModelId`
    (e.g. `claude-sonnet-4-5`) for `anthropic`.
  - `awsProfile` (bedrock only) — key into the top-level `aws.profiles` map naming the AWS
    identity this model authenticates through; falls back to `aws.default`.
- The supervisor resolves a task's model → registry entry → runtime + backend + target +
  resolved aws profile (`{ profile, account?, region? }`).
- **Selection:** register two entries to expose both paths for one model, or override per run
  with `--backend <bedrock|anthropic>`.
- **AWS profiles (`aws.profiles` + `aws.default`):** named identities, each `{ profile,
  account?, region? }`. A bedrock model's `awsProfile` selects one; both credential paths (JS
  SDK and the Claude SDK subprocess) are pinned to it, so **different models can run in
  different accounts/regions**. Before use, `ensureAuth` calls `sts:GetCallerIdentity` through
  the JS SDK path and asserts the resolved account equals `account` — a mismatch stops loudly
  instead of misrouting. Interactive entry points (`tack session start`, `tack aws login`,
  `tack model add --aws-profile`) drive `aws sso login` on an expired session; the detached
  supervisor re-verifies non-interactively and fails with a `tack aws login <key>` hint.
  Managed via `tack aws {list,add,remove,set-default,login,whoami}`. With no profiles
  configured, models fall back to the default AWS provider chain (pre-config behavior).
- **Credentials:** `bedrock` → the model's aws profile, else the default AWS credential chain
  (SSO profiles expected); `anthropic` → `ANTHROPIC_API_KEY` **from the environment, never
  stored in the config file**.

> **Operational note (two credential paths):** the `claude` runtime resolves AWS creds via
> the Claude Agent SDK's bundled CLI (Tack passes it `AWS_PROFILE`/`AWS_REGION` derived from
> the model's aws profile), while the `tack` runtime **and the planner** resolve creds via
> `@langchain/aws` → the in-process JS AWS SDK (pinned to the same profile's credentials).
> These can differ: an environment where the CLI works (e.g. SSO the CLI understands) may
> still fail the JS chain with "Could not load credentials from any providers". The account
> preflight (`ensureAuth`, via `sts:GetCallerIdentity`) runs on the JS SDK path, so it also
> catches this gap before spend. Ensure creds are resolvable by the JS SDK (the profile's
> SSO/role creds, or env vars) for the planner and non-Anthropic models to run.

---

## CLI surface (citty)

# Grouped by the three model concepts — session / run / task — plus cross-cutting commands.
```
tack [session start] [--model <name>] [--resume <sessionId>]  # primary interface: planning session
tack session list                                         # list planning sessions
tack session show <sessionId>                             # a session's run/task tree
                                                            # (work is kicked off only via a session's delegate)

tack run list [--status <s>]                              # list runs
tack run show <run>                                       # detail: context, amendments, diffs
tack run logs <run> [-f]                                  # tail the per-run log
tack run stop <run>                                       # SIGTERM the supervisor
tack run retry <run>                                      # respawn supervisor from state

tack task list [<run>]                                    # list tasks/agents
tack task logs <task> [-f]                                # tail the per-task log

tack watch                                                # Ink live dashboard

tack project add <path>                                   # read README + CLAUDE.md → draft description → write config
tack project list | rm <name>
tack model list
```

---

## Project layout

```
bin/
  tack.ts          # CLI entry (citty), Bun shebang
  supervisor.ts      # detached supervisor entrypoint: `bun supervisor.ts <runId>`
src/
  cli/               # citty commands + Ink dashboard + chat REPL (cli/chat.ts)
  config/            # load tack.config.ts; project/model registries; allowlist
  models/            # registry resolution → { runtime, inferenceProfile }
  planner/           # planning sessions: PlannerRuntime (claude|tack), actions,
                     #   delegation/read-only tools, session orchestration
  orchestrator/      # plain-TS supervisor: plan, fanout, adjudicate, reconcile
  runtimes/
    index.ts         # AgentRuntime interface + selection
    claude.ts        # ClaudeRuntime (Claude Agent SDK)
    tack.ts        # TackRuntime (LangGraph + ChatBedrockConverse)
  tools/             # worktree-scoped read/write/edit/search/shell/git (TackRuntime) +
                     # shared coordination tools (read_shared_context, propose_amendment)
  worktree/          # git worktree create/cleanup
  db/                # better-sqlite3 connection, migrations, repositories
  process/           # detached spawn, lifecycle, signals, pid liveness
  logging/           # per-run / per-task log files
tack.config.ts     # user config (projects, models, allowlist)
docs/architecture.md # this file
```

---

## Build plan

1. ✅ **Foundations** — config loading, model registry (+ provider/runtime), DB schema/migrations
   (`bun:sqlite`, not `better-sqlite3`), detached-process + logging plumbing.
2. ✅ **`AgentRuntime` interface + `TackRuntime`** — LangGraph react agent, our worktree-scoped
   tools + read allowlist. (Persistent checkpointer resume still uses in-memory `MemorySaver`.)
3. ✅ **`ClaudeRuntime`** — wraps the Claude Agent SDK on Bedrock/Anthropic; tools/permissions/scoping
   via hooks; both runtimes satisfy the same contract.
4. ✅ **Detached supervisor + lifecycle** — `ps`/`runs`/`logs`/`stop`/`retry`.
5. ✅ **Planner + fan-out** — multi-project selection, parallel implementers. Fan-out verified live
   on `claude`; planner needs a JS-SDK-resolvable AWS credential path (see operational note).
6. ✅ **Shared context + reconcile** — contract authoring (planner) / default, distribution via the
   `read_shared_context` / `propose_amendment` tools in both runtimes, reconcile summary.
7. ✅ **Live amendments + adjudication** — option (b): `propose_amendment` is adjudicated synchronously
   by the powerful model (accept → version-bump; reject → conform; degrades to queuing). *Deferred
   live test* — the adjudicator uses `ChatBedrockConverse` (credential note).
8. ✅ **Ink dashboard (`tack watch`) + `tack show` + cost accounting.**

Status: all eight steps implemented and typecheck-clean. Live-verified via the `claude` runtime:
single/parallel agents, tools + scoping, lifecycle, coordination tools, reconcile. Not yet
live-verified (JS-SDK credential gap in the dev environment): the planner, the adjudicator, and the
`tack` runtime — all use `ChatBedrockConverse`. Remaining polish: a persistent `bun:sqlite`
checkpointer for the `tack` runtime (step-2 note), a leaner background-agent system prompt to cut
the ~$0.22 preset overhead per `claude` task.

---

## Deferred / future

- Coordinated *dependent* changes beyond a shared contract (e.g. staged rollout ordering).
- Hard sandbox around `shell` if the read allowlist must be a true boundary.
- Auto-resume-on-boot (launchd agent wrapping `tack retry`).
- Remote / multi-user execution.
- `bun build --compile` single-binary distribution.
