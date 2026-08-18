# Hermes

A personal, local development harness. You hand it a **problem statement**; it decides which
of your locally checked-out projects are relevant, spins up an isolated git worktree in each,
and dispatches background agents (any model on AWS Bedrock) to work the problem in parallel —
coordinating them through a shared contract so cross-repo changes stay consistent.

- **Model-agnostic** over Bedrock (Claude, Llama, Mistral, Nova, …); Anthropic models can also
  run via the first-party API.
- **Background agents** that survive your terminal closing, run in parallel, and are resumable.
- **CLI**, built on Bun + TypeScript.

See [`docs/architecture.md`](docs/architecture.md) for the full design.

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

To get a global `hermes` binary, link it once:

```bash
bun link                          # then: hermes <command>
```

The examples below use `hermes <command>`; substitute `bun run hermes <command>` if you skip
linking.

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

```bash
# Kick off a run. Without --projects, the planner selects projects and authors a contract.
hermes run "Add a health-check endpoint and document it"
hermes run "Bump the shared API version" --projects api,web   # explicit; skips the planner
hermes run "…" --model claude-sonnet --backend bedrock

# Inspect
hermes runs                 # list runs (running / stalled / done / failed + cost)
hermes ps [<run>]           # list tasks/agents
hermes show <run>           # contract, tasks, amendments
hermes logs <run|task> [-f] # tail logs (-f to follow)
hermes watch                # live Ink dashboard (press q to quit)

# Control
hermes stop <run>           # SIGTERM the run's supervisor
hermes resume <run>         # re-run a run's incomplete tasks

# Single-project foreground run (dev/debugging), streams to your terminal
hermes agent "Refactor the config loader" --project api --keep

# Registries
hermes project list
hermes model list
```

A `hermes run` returns immediately with a run id; a **detached supervisor process** does the
work in the background (it survives your terminal closing). Worktrees are created under
`~/.hermes/worktrees/<run>/<project>` and kept so you can review and merge the agents' changes.

## How it works (in brief)

```
hermes run "problem"  →  detached supervisor (one per run)
   plan (powerful model: pick projects + author shared contract)
     → fan out one agent per project (parallel, isolated worktrees)
        → agents read the contract; may propose_amendment (adjudicated live)
     → reconcile (summarize changes vs contract, surface amendments)
```

State lives in SQLite (`~/.hermes/hermes.db`); logs in `~/.hermes/logs/<run>/`. There is no
always-on daemon — only active runs have a process.

## Development

```bash
bun run typecheck     # tsc --noEmit
```

## Status

All core functionality is implemented. Live-verified on the `claude` runtime (single + parallel
agents, scoped tools, supervisor lifecycle, coordination tools, reconcile). The planner,
adjudicator, and `hermes` runtime use the Bedrock Converse API and require a JS-SDK-resolvable
credential path (see the credential note above).
