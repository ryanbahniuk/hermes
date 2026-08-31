# Tack

A personal, local development harness. Its primary interface is an **interactive planning
session**: you chat with a **planner agent** that clarifies requirements and — once the goal is
clear — **delegates** to a swarm of background worker agents. The planner never edits code
itself; it plans, investigates read-only, and dispatches. Workers run in isolated git worktrees
across your locally checked-out projects, coordinated through a shared contract so cross-repo
changes stay consistent.

- **Interactive planner** as the front door (`tack session start`, or just `tack`) — an ongoing,
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
git clone <this repo> && cd tack
bun install
```

Run the CLI during development with:

```bash
bun run tack <command>          # e.g. bun run tack init
```

### A global `tack` command

Two ways to get `tack` on your `PATH`:

**Standalone binary (recommended).** Compile a single self-contained executable that embeds
the Bun runtime — no `bun` or repo checkout needed at runtime:

```bash
bun run build                     # -> dist/tack
install -m 755 dist/tack ~/.local/bin/tack   # any dir on your PATH (e.g. /usr/local/bin)
tack --help
```

Rebuild (`bun run build`) and re-copy after pulling changes.

**Dev symlink.** `bun link` puts `tack` in `~/.bun/bin`, but it's just a symlink back into
this repo — it still needs the repo checked out and `bun` installed. Make sure `~/.bun/bin` is
on your `PATH` first (Bun's installer usually does this, but verify with `which tack` after
linking):

```bash
# If ~/.bun/bin isn't on your PATH yet, add this to ~/.zshrc / ~/.bashrc:
export PATH="$HOME/.bun/bin:$PATH"

bun link                          # then: tack <command>
```

The examples below use `tack <command>`; substitute `bun run tack <command>` if you skip
both.

## Setup

1. **Initialize** the Tack home directory and a starter config:

   ```bash
   tack init
   ```

   This creates `~/.tack/` containing `tack.config.ts` (your config), `tack.db` (state),
   and `logs/`. Override the location with `TACK_HOME=/path tack …`.

2. **Configure AWS profiles.** Register the account(s)/region(s) your Bedrock models live in
   as named **aws profiles**, so each model authenticates as its own identity — and Tack can
   drive `aws sso login` and verify you're on the expected account for you:

   ```bash
   # key            shared-config profile                         account         region
   tack aws add coding-tools \
     --profile coding-tools-aws-coding-tools-bedrock \
     --region us-east-1 --login          # --login runs `aws sso login`, then fills --account from STS
   tack aws list                        # profiles, their accounts/regions, and which models use each
   tack aws whoami                      # verify every profile's identity (checks the account matches)
   tack aws login [key]                 # sign in to one profile, or all of them
   ```

   Each profile pins a shared-config `profile`, its 12-digit `account` (asserted via
   `sts:GetCallerIdentity` so a wrong or expired profile fails loudly instead of silently
   hitting another account), and the `region` its inference profiles live in. A model selects
   one with `awsProfile: "<key>"`; `tack aws set-default <key>` sets the fallback for models
   that don't name one. **Different models can live in different accounts** — a planner in one,
   an implementer in another — and each is authenticated and account-verified independently.
   Starting a session preflights every profile it will use (driving `aws sso login` when a
   session has expired); the background supervisor re-verifies non-interactively and stops with
   a `tack aws login <key>` hint rather than misrouting.

   If you configure **no** aws profiles, Tack falls back to the default AWS provider chain
   (`AWS_PROFILE` / `AWS_REGION` / env creds) exactly as before — the feature is opt-in.

   > **Note — two credential paths.** The `claude` runtime resolves creds via the Claude
   > Agent SDK's CLI (Tack passes it `AWS_PROFILE`/`AWS_REGION` from the model's aws profile),
   > while the `tack` runtime **and the planner/adjudicator** resolve creds via the in-process
   > JS AWS SDK (pinned to the same profile). An environment where only the CLI works (e.g.
   > certain SSO setups) will fail the planner with *"Could not load credentials"*. Make sure the
   > JS SDK default chain can load the profile's creds.

3. **Register your projects and models** in `~/.tack/tack.config.ts`. Both
   registries have CLI commands, so you never have to hand-edit the file:

   ```bash
   tack project add <name> <path> -d "<description>"
   tack project list
   tack model discover   # find the Bedrock models your AWS identity can invoke
   tack model add <name> <version> --model-id <id>   # add one (profile auto-resolved)
   tack model list
   ```

   `tack model discover` inspects your Bedrock account (foundation models +
   inference profiles) **and** the Mantle gateway catalog, merging both into one
   list of the chat models you can reach. `READY` means a usable
   application-inference-profile ARN exists; `DISCOVERED_NOT_VALIDATED` marks
   Mantle gateway entries (visible but not confirmed invokable). Use
   `--ready-only` to hide the rest, `--profile`/`--region` to target a specific
   identity, and `--json` for scripting.

   `tack model add` then registers one **without you ever touching an inference
   profile**: give it a friendly `<name> <version>` plus the Bedrock `--model-id`
   from discover (or let it match by `--provider` + name/version), and it resolves
   the READY application-inference-profile ARN for you and writes the entry.
   Escape hatches: `--inference-profile <arn>` (set the target directly, skip
   discovery) and `--api-model-id <id>` (first-party Anthropic API backend
   instead of Bedrock). Pass `--aws-profile <key>` (a key from `tack aws list`)
   to bind the model to a specific account/region — discovery then authenticates
   as that profile (driving `aws sso login` if needed) and the entry is tagged so
   it always runs there. For a **bedrock** model, `tack model add` **auto-fetches**
   pricing so cost can be computed: it pulls the model's on-demand rates from the
   AWS Price List API and hands the raw products to your `summaryModel` to match
   them to the model (no brittle attribute parser), then writes the resolved per-1M
   `pricing` into the entry. Resolved rates are cached in
   `~/.tack/pricing-cache.json`; `tack model price refresh` re-fetches for **every**
   bedrock model and rewrites their `pricing` (needs a bedrock-backed
   `defaults.summaryModel`). To set a rate by hand, edit the entry's `pricing` in
   `~/.tack/tack.config.ts`. Remove a model with `tack model remove <name> [version]`.

   > Cost precedence at runtime is unchanged: the `claude` runtime uses the Claude
   > SDK's reported USD; the `tack` runtime multiplies tokens by this `pricing`.
   > These Price-List rates are **list price** (no negotiated discounts) — a good
   > estimate, not your invoice.

   One `name@version` can be registered under **multiple variants** — a model's
   identity is the full `(name, version, runtime, backend)` tuple. Run
   `tack model add` again with a different `--runtime`/`--backend` to expose, say,
   both the first-party `anthropic` backend and a `bedrock`/`tack` path for the
   same model. When several variants share a `name@version`, reference a specific
   one by appending `+<qualifier>` suffixes — a backend and/or runtime,
   order-independent: `claude-sonnet@4.5+anthropic`, `claude-sonnet@4.5+bedrock+tack`.
   An under-specified reference that matches more than one variant fails and lists
   the choices rather than guessing; `tack model remove`/`verify` also take
   `--runtime`/`--backend` to pin one.

   Add `--verify` to actually invoke each model with a minimal prompt and confirm
   which ones work for *your* profile — native models via the Bedrock Converse API,
   Mantle models via their signed gateway route. Models are annotated `✓ works` /
   `✗ fails` (with the failure reason). This catches cases a plain listing can't,
   e.g. a `READY` application profile whose role still lacks `bedrock:InvokeModel`.
   These are real, billable inference calls (one per model), so it's opt-in —
   scope it with `--ready-only` to keep it cheap.

   Pick which registered models each role uses (roles: `planner`, `implementer`,
   `summary`). Two levels, checked in this order:

   - `tack model set <role> <name[@version]>` → `overrides` — a **hard pin**
     that wins over intelligent routing. Use it to force a specific model.
   - `tack model set-default <role> <name[@version]>` → `defaults` — the
     **fallback** the router falls back to when it has no strong pick.

   Full precedence per role: an explicit `--model` flag → override → intelligent
   routing (planned) → default. The planner and summary roles must be
   bedrock-backed; the implementer may be any registered model. `--clear` unsets
   a role in either section, and `tack model list` prints both.

## Configuration

`~/.tack/tack.config.ts` must `export default` a config object:

```ts
export default {
  // Locally checked-out repos Tack may use. The description guides the planner.
  projects: [
    { name: "api", path: "~/code/api", description: "Backend REST API service." },
    { name: "web", path: "~/code/web", description: "React web frontend." },
  ],

  // Named AWS identities models authenticate through (manage with `tack aws …`).
  // Each pins a shared-config profile, its account (verified via STS), and region.
  aws: {
    profiles: {
      "coding-tools": { profile: "coding-tools-aws-coding-tools-bedrock", account: "602028460818", region: "us-east-1" },
    },
    default: "coding-tools",             // used by models that don't name their own
  },

  // Models available to the planner and implementers.
  //   runtime     defaults: provider "anthropic" -> "claude", otherwise -> "tack".
  //   backend     defaults to "bedrock".
  //   awsProfile  key into aws.profiles; falls back to aws.default.
  models: [
    {
      name: "claude-sonnet",
      version: "4.5",
      provider: "anthropic",
      inferenceProfile: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", // your real profile id
      awsProfile: "coding-tools",        // which account/region this model runs in
    },

    // First-party Anthropic API instead of Bedrock (needs ANTHROPIC_API_KEY in your env):
    // { name: "claude-sonnet", version: "4.5-api", provider: "anthropic",
    //   backend: "anthropic", apiModelId: "claude-sonnet-4-5" },

    // A non-Anthropic Bedrock model runs through the "tack" runtime. Add pricing
    // (USD per 1M tokens) so cost can be computed — the tack runtime has no
    // SDK-reported cost like the claude runtime does.
    // { name: "llama", version: "3.3-70b", provider: "meta",
    //   inferenceProfile: "us.meta.llama3-3-70b-instruct-v1:0",
    //   pricing: { inputPer1M: 0.72, outputPer1M: 0.72 } },
  ],

  // Extra directories the read tool may read (read-only), beyond each worktree.
  readAllowlist: [],

  defaults: {                            // fallback per role (routing falls back here)
    plannerModel: "claude-sonnet",       // powerful model: planning + adjudication
    // implementerModel: "claude-sonnet", // defaults to plannerModel if omitted
  },

  overrides: {                           // hard pins — win over intelligent routing
    // plannerModel: "claude-sonnet",
  },
};
```

Key fields:

| Field | Notes |
|---|---|
| `projects[].path` | Must be a **git repository root**. `~` is expanded. |
| `models[].runtime` | `claude` (Claude Agent SDK) or `tack` (LangGraph + Bedrock Converse). Inferred from `provider`, overridable. |
| `models[].backend` | `bedrock` (default) or `anthropic` (first-party API; `claude` runtime + `provider: anthropic` only). |
| `models[].awsProfile` | Key into `aws.profiles` — the account/region/profile this bedrock model authenticates through. Falls back to `aws.default`. |
| `models[].pricing` | Optional USD-per-1M-token rates; used to compute cost for the `tack` runtime. |
| `aws.profiles` | Named AWS identities (`{ profile, account?, region? }`). `account` is asserted via STS so a wrong/expired profile fails loudly. Manage with `tack aws …`. |
| `aws.default` | Profile key used by bedrock models that don't set `awsProfile`. Omit to use the default AWS provider chain. |
| `readAllowlist` | Directories the read tool may read outside the worktree. (`shell` is trusted and not bounded by this.) |

## Usage

### The primary interface: a planning session

```bash
tack                             # open a planning session (bare == `tack session start`)
tack session start               # same thing, explicit
tack session start --model claude-sonnet
tack session start --resume <sessionId>   # or: tack --resume <sessionId>
tack session list                # list your planning sessions
tack session show <sessionId>    # its run/task tree (top-down view)
tack session kill <sessionId>    # stop its background runs + mark it closed (keeps data)
tack session delete <sessionId>  # permanently erase it (runs, worktrees, logs, messages)
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

The CLI is organized by the three model concepts — **`session`**, **`run`**, **`task`** — each
grouping the verbs that act on it (plus the top-level `watch`, `init`, `model`, `project`).

```bash
# Inspect
tack run list             # list runs (running / stalled / done / failed + cost)
tack task list [<run>]    # list tasks/agents (optionally filtered to one run)
tack run show <run>       # a run's contract, tasks, amendments
tack session show <sess>  # a session's run/task tree (top-down view)
tack run logs <run> [-f]  # tail a run's log (-f to follow)
tack task logs <task> [-f]# tail a task's log
tack watch                # live Ink dashboard (press q to quit)

# Control
tack run stop <run>       # SIGTERM the run's supervisor
tack run retry <run>      # respawn the supervisor to re-run incomplete tasks
tack session kill <sess>  # stop every run the session dispatched, mark it closed
tack session delete <sess># erase the session and everything it spawned (worktrees, logs, rows)

# Registries
tack project list
tack project add <name> <path> -d "<description>"   # register a project
tack project remove <name>                          # unregister a project
tack model list
tack model discover       # discover invokable Bedrock + Mantle models and their targets
tack model discover --verify  # …and probe each to confirm it works for your profile
tack model add <name> <version> --model-id <id>   # register one (inference profile auto-resolved)
                                                   # …add again with --runtime/--backend to register
                                                   #   another variant of the same name@version
tack model remove <name> [version] [--runtime R] [--backend B]  # unregister (pin a variant when several)
tack model price refresh   # re-fetch on-demand pricing for all bedrock models (AWS Price List)
tack model set-default planner <name[@version]>     # fallback planner model
tack model set-default implementer <name[@version]> # fallback implementer model
tack model set implementer <name[@version]>         # hard pin (overrides routing)
tack model set <role> --clear                       # remove an override

# AWS profiles (accounts/regions models authenticate through)
tack aws list                          # profiles, accounts/regions, and which models use each
tack aws add <key> --profile <name> --region <r> --login   # add one; --login signs in + fills account
tack aws login [key]                   # `aws sso login` + verify one profile, or all of them
tack aws whoami [key]                  # verify identity/account without logging in
tack aws set-default <key>             # profile for models that don't name one (--clear to unset)
tack aws remove <key>                  # unregister a profile (refused while a model uses it)
```

`project add`/`remove` and `model add`/`remove` edit `~/.tack/tack.config.ts` in place,
rewriting only the relevant array and leaving everything else — your other entries, comments,
and formatting — untouched. (Quote a project path — `'~/code/api'` — if you want the literal
`~` preserved rather than shell-expanded.)

A delegated run returns immediately with a run id; a **detached supervisor process** does the
work in the background (it survives your terminal closing). Worktrees are created under
`~/.tack/worktrees/<run>/<project>` and kept so you can review and merge the agents' changes.

## How it works (in brief)

```
tack session start  →  interactive planning session (foreground, one planner agent)
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
LangGraph), same as the workers. State lives in SQLite (`~/.tack/tack.db`) — including
sessions and their transcripts; logs in `~/.tack/logs/<run>/`. There is no always-on daemon —
only the foreground chat and active runs have a process.

## Development

```bash
bun run typecheck     # tsc --noEmit
```

## Status

All core functionality is implemented. Live-verified on the `claude` runtime (single + parallel
agents, scoped tools, supervisor lifecycle, coordination tools, reconcile). The planner,
adjudicator, and `tack` runtime use the Bedrock Converse API and require a JS-SDK-resolvable
credential path (see the credential note above).
