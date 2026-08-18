# Hermes

A personal, local development harness. Its primary interface is an **interactive planning
session**: you chat with a **planner agent** that clarifies requirements and — once the goal is
clear — **delegates** to a swarm of background worker agents. The planner never edits code
itself; it plans, investigates read-only, and dispatches. Workers run in isolated git worktrees
across your locally checked-out projects, coordinated through a shared contract so cross-repo
changes stay consistent.

- **Interactive planner** as the front door (`hermes chat`, or just `hermes`) — an ongoing,
  resumable conversation, not a fire-and-forget command.
- **Model-agnostic** over Bedrock (Claude, Llama, Mistral, Nova, …) for both the planner and the
  workers; Anthropic models can also run via the first-party API.
- **Background worker agents** that survive your terminal closing, run in parallel, and are
  resumable.
- **CLI**, built on Bun + TypeScript.

New here? Read [`docs/model.md`](docs/model.md) for the mental model (Session → Run → Task) in
five minutes. See [`docs/architecture.md`](docs/architecture.md) for the full design.

---

## Requirements

- **[Bun](https://bun.sh)** ≥ 1.3
- **git** (worktrees are used for isolation)
- **AWS credentials** with Bedrock access + at least one enabled **inference profile**
- Optional: **ripgrep** (`rg`) — the `search` tool falls back to `grep` if it's absent

## Install

```bash
git clone <this repo> && cd hermes
bun install
```

Run the CLI during development with:

```bash
bun run hermes <command>          # e.g. bun run hermes init
```

### A global `hermes` command

Two ways to get `hermes` on your `PATH`:

**Standalone binary (recommended).** Compile a single self-contained executable that embeds
the Bun runtime — no `bun` or repo checkout needed at runtime:

```bash
bun run build                     # -> dist/hermes
install -m 755 dist/hermes ~/.local/bin/hermes   # any dir on your PATH (e.g. /usr/local/bin)
hermes --help
```

Rebuild (`bun run build`) and re-copy after pulling changes.

**Dev symlink.** `bun link` puts `hermes` in `~/.bun/bin`, but it's just a symlink back into
this repo — it still needs the repo checked out and `bun` installed. Make sure `~/.bun/bin` is
on your `PATH` first (Bun's installer usually does this, but verify with `which hermes` after
linking):

```bash
# If ~/.bun/bin isn't on your PATH yet, add this to ~/.zshrc / ~/.bashrc:
export PATH="$HOME/.bun/bin:$PATH"

bun link                          # then: hermes <command>
```

The examples below use `hermes <command>`; substitute `bun run hermes <command>` if you skip
both.

## Setup

1. **Initialize** the Hermes home directory and a starter config:

   ```bash
   hermes init
   ```

   This creates `~/.hermes/` containing `hermes.config.ts` (your config), `hermes.db` (state),
   and `logs/`. Override the location with `HERMES_HOME=/path hermes …`.

2. **Configure AWS credentials.** Hermes uses the default AWS provider chain — export env
   vars or a profile so **both** credential paths resolve:

   ```bash
   export AWS_REGION=us-east-1
   export AWS_PROFILE=your-profile          # or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / …
   ```

   > **Note — two credential paths.** The `claude` runtime resolves creds via the Claude
   > Agent SDK's CLI, while the `hermes` runtime **and the planner/adjudicator** resolve creds
   > via the in-process JS AWS SDK. An environment where only the CLI works (e.g. certain SSO
   > setups) will fail the planner with *"Could not load credentials"*. Make sure the JS SDK
   > default chain can load your creds (env vars, or `AWS_PROFILE` pointing at a resolvable
   > profile).

3. **Edit `~/.hermes/hermes.config.ts`** to register your projects and models (see below).
   Inspect what's configured with:

   ```bash
   hermes project list
   hermes model list
   ```

## Configuration

`~/.hermes/hermes.config.ts` must `export default` a config object:

```ts
export default {
  // Locally checked-out repos Hermes may use. The description guides the planner.
  projects: [
    { name: "api", path: "~/code/api", description: "Backend REST API service." },
    { name: "web", path: "~/code/web", description: "React web frontend." },
  ],

  // Models available to the planner and implementers.
  //   runtime  defaults: provider "anthropic" -> "claude", otherwise -> "hermes".
  //   backend  defaults to "bedrock".
  models: [
    {
      name: "claude-sonnet",
      version: "4.5",
      provider: "anthropic",
      inferenceProfile: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", // your real profile id
    },

    // First-party Anthropic API instead of Bedrock (needs ANTHROPIC_API_KEY in your env):
    // { name: "claude-sonnet", version: "4.5-api", provider: "anthropic",
    //   backend: "anthropic", apiModelId: "claude-sonnet-4-5" },

    // A non-Anthropic Bedrock model runs through the "hermes" runtime. Add pricing
    // (USD per 1M tokens) so cost can be computed — the hermes runtime has no
    // SDK-reported cost like the claude runtime does.
    // { name: "llama", version: "3.3-70b", provider: "meta",
    //   inferenceProfile: "us.meta.llama3-3-70b-instruct-v1:0",
    //   pricing: { inputPer1M: 0.72, outputPer1M: 0.72 } },
  ],

  // Extra directories the read tool may read (read-only), beyond each worktree.
  readAllowlist: [],

  defaults: {
    plannerModel: "claude-sonnet",       // powerful model: planning + adjudication
    // implementerModel: "claude-sonnet", // defaults to plannerModel if omitted
  },
};
```

Key fields:

| Field | Notes |
|---|---|
| `projects[].path` | Must be a **git repository root**. `~` is expanded. |
| `models[].runtime` | `claude` (Claude Agent SDK) or `hermes` (LangGraph + Bedrock Converse). Inferred from `provider`, overridable. |
| `models[].backend` | `bedrock` (default) or `anthropic` (first-party API; `claude` runtime + `provider: anthropic` only). |
| `models[].pricing` | Optional USD-per-1M-token rates; used to compute cost for the `hermes` runtime. |
| `readAllowlist` | Directories the read tool may read outside the worktree. (`shell` is trusted and not bounded by this.) |

## Usage

### The primary interface: a planning session

```bash
hermes                      # open a planning session (bare command == `hermes chat`)
hermes chat                 # same thing, explicit
hermes chat --model claude-sonnet
hermes chat --resume <sessionId>   # or: hermes --resume <sessionId>
hermes sessions             # list your planning sessions
```

You then just talk to the planner. It asks clarifying questions, reads your projects
(read-only) to ground itself, and when the goal is clear it calls its `delegate` tool to
dispatch a worker swarm — a background run. It reports progress back with `check_runs`, and you
keep iterating. In-session commands: `/runs`, `/help`, `/exit`. The session is persisted, so it
never disappears — resume it any time.

Sessions are the only way to kick off work. There is no direct "start a run" command — you
delegate from within a planning session. The commands below are read-only inspection and
lifecycle control over runs a session has already dispatched.

### Inspecting and controlling dispatched runs

```bash
# Inspect
hermes runs                 # list runs (running / stalled / done / failed + cost)
hermes ps [<run>]           # list tasks/agents
hermes show <run>           # contract, tasks, amendments
hermes logs <run|task> [-f] # tail logs (-f to follow)
hermes watch                # live Ink dashboard (press q to quit)

# Control
hermes stop <run>           # SIGTERM the run's supervisor
hermes resume <run>         # re-run a run's incomplete tasks

# Registries
hermes project list
hermes model list
```

A delegated run returns immediately with a run id; a **detached supervisor process** does the
work in the background (it survives your terminal closing). Worktrees are created under
`~/.hermes/worktrees/<run>/<project>` and kept so you can review and merge the agents' changes.

## How it works (in brief)

```
hermes chat  →  interactive planning session (foreground, one planner agent)
   ├─ clarifies requirements with you (multi-turn conversation, persisted + resumable)
   ├─ investigates your projects read-only (it cannot edit code)
   └─ delegate(problem[, projects, sharedContext])  ─┐  (a tool the planner calls)
                                                      ▼
                          detached supervisor (one per run)
      plan (powerful model: pick projects + author shared contract)
        → fan out one worker agent per project (parallel, isolated worktrees)
           → workers read the contract; may propose_amendment (adjudicated live)
        → reconcile (summarize changes vs contract, surface amendments)
```

The planner runs on either runtime (claude via the Claude Agent SDK, or any Bedrock model via
LangGraph), same as the workers. State lives in SQLite (`~/.hermes/hermes.db`) — including
sessions and their transcripts; logs in `~/.hermes/logs/<run>/`. There is no always-on daemon —
only the foreground chat and active runs have a process.

## Development

```bash
bun run typecheck     # tsc --noEmit
```

## Status

All core functionality is implemented. Live-verified on the `claude` runtime (single + parallel
agents, scoped tools, supervisor lifecycle, coordination tools, reconcile). The planner,
adjudicator, and `hermes` runtime use the Bedrock Converse API and require a JS-SDK-resolvable
credential path (see the credential note above).
