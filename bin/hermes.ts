#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { loadConfig } from "../src/config/load";
import {
  addProjectToConfig,
  removeProjectFromConfig,
  addModelToConfig,
  removeModelFromConfig,
  setSectionModel,
  clearSectionModel,
  addAwsProfileToConfig,
  removeAwsProfileFromConfig,
  setDefaultAwsProfile,
  type ModelRoleKey,
  type ModelSection,
} from "../src/config/edit";
import type { AwsProfile, ModelInput, Pricing } from "../src/config/schema";
import { resolveModel } from "../src/models/registry";
import {
  ensureAuth,
  resolveAwsProfile,
  type ResolvedAwsProfile,
} from "../src/models/aws";
import { ensureSessionAuth } from "../src/models/preflight";
import { generateProjectDescription } from "../src/projects/describe";
import { CONFIG_PATH } from "../src/paths";
import {
  db,
  listRuns,
  listTasks,
  getRun,
  getTask,
  getSharedContext,
  listAmendments,
  setSupervisorPid,
  listSessions,
  getSession,
  listRunsBySession,
  sessionTotalCost,
} from "../src/db";
import { spawnSupervisor, isAlive } from "../src/process/spawn";
import { followLog, readLog, runLogFile, taskLogFile } from "../src/logging/logs";
import { initHome } from "../src/init";
import { supervise } from "../src/orchestrator/supervise";

/** Wraps a command body so thrown errors print as one clean red line. */
function action<C>(fn: (ctx: C) => unknown | Promise<unknown>) {
  return async (ctx: C): Promise<void> => {
    try {
      await fn(ctx);
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  };
}

const init = defineCommand({
  meta: { name: "init", description: "Create the Hermes home dir + starter config" },
  run: action(() => {
    const r = initHome();
    console.log(pc.green(`Hermes home: ${r.home}`));
    console.log(
      r.createdConfig
        ? pc.dim(`  wrote starter config -> ${r.configPath}`)
        : pc.dim(`  config already exists -> ${r.configPath}`),
    );
  }),
});

const sessionStart = defineCommand({
  meta: { name: "start", description: "Start (or --resume) an interactive planning session — the primary interface" },
  args: {
    model: { type: "string", description: "Planner model name (or name@version)" },
    resume: { type: "string", description: "Resume an existing session id" },
  },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    const config = await loadConfig();
    // Preflight AWS auth for every profile this session will use (planner +
    // implementer + summary), driving `aws sso login` when a session has expired.
    // Runs must dispatch to detached supervisors with no TTY, so we log in here
    // where the browser flow can complete. Inert until aws profiles are configured.
    await ensureSessionAuth(config, {
      plannerOverride: args.model as string | undefined,
      autoLogin: true,
    });
    const { runChat } = await import("../src/cli/chat");
    await runChat(config, {
      modelRef: args.model as string | undefined,
      resume: args.resume as string | undefined,
    });
  }),
});

const sessionList = defineCommand({
  meta: { name: "list", description: "List planning sessions" },
  run: action(() => {
    db();
    const rows = listSessions();
    if (rows.length === 0) return void console.log(pc.dim("No sessions yet. Start one with `hermes session start`."));
    for (const s of rows) {
      const live = s.status === "active" ? pc.green("active") : pc.dim("closed");
      const cost = sessionTotalCost(s.id);
      console.log(
        `${pc.bold(s.id)}  ${live}  ${pc.dim(`$${cost.total.toFixed(4)}`)}` +
          pc.dim(` (plan $${cost.planner.toFixed(4)} + work $${cost.work.toFixed(4)})`) +
          `  ${pc.dim(s.planner_model ?? "-")}  ${s.title ?? pc.dim("(untitled)")}`,
      );
    }
  }),
});

const runList = defineCommand({
  meta: { name: "list", description: "List runs" },
  run: action(() => {
    db();
    const rows = listRuns();
    if (rows.length === 0) return void console.log(pc.dim("No runs yet."));
    for (const r of rows) {
      const terminal = r.status === "done" || r.status === "failed";
      const live = terminal
        ? pc.dim(r.status)
        : isAlive(r.supervisor_pid)
          ? pc.green("running")
          : pc.yellow("stalled");
      console.log(
        `${pc.bold(r.id)}  ${live}  ${pc.dim(`$${r.cost.toFixed(4)}`)}  ${pc.dim(r.problem.slice(0, 60))}`,
      );
    }
  }),
});

const taskList = defineCommand({
  meta: { name: "list", description: "List tasks/agents" },
  args: { run: { type: "positional", required: false, description: "Filter by run id" } },
  run: action(({ args }: { args: Record<string, unknown> }) => {
    db();
    const tasks = listTasks(args.run ? String(args.run) : undefined);
    if (tasks.length === 0) return void console.log(pc.dim("No tasks."));
    for (const t of tasks) {
      console.log(
        `${pc.bold(t.id)}  ${pc.dim(t.run_id)}  ${t.project_name}  ${pc.dim(t.status)}  ${t.runtime ?? "-"}  ${pc.dim(`$${t.cost.toFixed(4)}`)}`,
      );
    }
  }),
});

const runLogs = defineCommand({
  meta: { name: "logs", description: "Tail a run's log" },
  args: {
    run: { type: "positional", required: true, description: "run id" },
    follow: { type: "boolean", alias: "f", default: false, description: "Follow output" },
  },
  run: action(({ args }: { args: Record<string, unknown> }) => {
    db();
    const runId = String(args.run);
    if (!getRun(runId)) throw new Error(`No such run: ${runId}`);
    const file = runLogFile(runId);
    if (args.follow) return followLog(file);
    process.stdout.write(readLog(file));
  }),
});

const taskLogs = defineCommand({
  meta: { name: "logs", description: "Tail a task's log" },
  args: {
    task: { type: "positional", required: true, description: "task id" },
    follow: { type: "boolean", alias: "f", default: false, description: "Follow output" },
  },
  run: action(({ args }: { args: Record<string, unknown> }) => {
    db();
    const t = getTask(String(args.task));
    if (!t) throw new Error(`No such task: ${args.task}`);
    const file = taskLogFile(t.run_id, t.id);
    if (args.follow) return followLog(file);
    process.stdout.write(readLog(file));
  }),
});

const runStop = defineCommand({
  meta: { name: "stop", description: "Stop a run's supervisor" },
  args: { run: { type: "positional", required: true, description: "run id" } },
  run: action(({ args }: { args: Record<string, unknown> }) => {
    db();
    const r = getRun(String(args.run));
    if (!r) throw new Error(`No such run: ${args.run}`);
    if (!isAlive(r.supervisor_pid)) return void console.log(pc.yellow("Supervisor is not running."));
    process.kill(r.supervisor_pid!, "SIGTERM");
    console.log(pc.green(`Sent SIGTERM to supervisor pid ${r.supervisor_pid}`));
  }),
});

/** Prints full detail for one run: header, contract, tasks, amendments. */
function showRun(runId: string): void {
  const r = getRun(runId);
  if (!r) throw new Error(`No such run: ${runId}`);

  console.log(`${pc.bold(r.id)}  ${pc.cyan(r.status)}  ${pc.dim(`$${r.cost.toFixed(4)}`)}`);
  console.log(pc.dim(`planner: ${r.planner_model ?? "-"}   created: ${r.created_at}`));
  console.log(`${pc.bold("problem:")} ${r.problem}`);

  const sc = getSharedContext(r.id);
  console.log(pc.bold(`\nshared context: `) + (sc ? pc.dim(`v${sc.version} (by ${sc.authored_by})`) : pc.dim("(none)")));
  if (sc) console.log(sc.content);

  const tasks = listTasks(r.id);
  console.log(pc.bold(`\ntasks (${tasks.length}):`));
  for (const t of tasks) {
    console.log(
      `  ${pc.bold(t.project_name)}  ${pc.cyan(t.status)}  ${t.runtime ?? "-"}  ${pc.dim(`$${t.cost.toFixed(4)}`)}  ${pc.dim(t.id)}`,
    );
  }

  const amendments = listAmendments(r.id);
  console.log(pc.bold(`\namendments (${amendments.length}):`));
  for (const a of amendments) {
    const color = a.status === "accepted" ? pc.green : a.status === "rejected" ? pc.yellow : pc.dim;
    console.log(`  ${color(`[${a.status}]`)} ${a.proposal}`);
    if (a.resolution) console.log(pc.dim(`      → ${a.resolution}`));
  }
}

/** Prints a session's Session -> Run -> Task tree — the top-down view. */
function showSession(sessionId: string): void {
  const s = getSession(sessionId);
  if (!s) throw new Error(`No such session: ${sessionId}`);

  const live = s.status === "active" ? pc.green("active") : pc.dim("closed");
  const cost = sessionTotalCost(s.id);
  console.log(`${pc.bold(s.id)}  ${live}  ${pc.dim(`$${cost.total.toFixed(4)}`)}` +
    pc.dim(` (plan $${cost.planner.toFixed(4)} + work $${cost.work.toFixed(4)})`));
  console.log(pc.dim(`planner: ${s.planner_model ?? "-"}   created: ${s.created_at}`));
  console.log(`${pc.bold("title:")} ${s.title ?? pc.dim("(untitled)")}`);

  const runs = listRunsBySession(s.id);
  console.log(pc.bold(`\nruns (${runs.length}):`));
  if (runs.length === 0) {
    console.log(pc.dim("  (none dispatched yet)"));
    return;
  }
  for (const r of runs) {
    const terminal = r.status === "done" || r.status === "failed";
    const rlive = terminal
      ? pc.dim(r.status)
      : isAlive(r.supervisor_pid)
        ? pc.green("running")
        : pc.yellow("stalled");
    console.log(
      `  ${pc.bold(r.id)}  ${rlive}  ${pc.dim(`$${r.cost.toFixed(4)}`)}  ${pc.dim(r.problem.slice(0, 60))}`,
    );
    for (const t of listTasks(r.id)) {
      console.log(
        `    ${pc.bold(t.project_name)}  ${pc.cyan(t.status)}  ${t.runtime ?? "-"}  ${pc.dim(`$${t.cost.toFixed(4)}`)}  ${pc.dim(t.id)}`,
      );
    }
  }
  console.log(pc.dim(`\n  inspect a run: hermes run show <run>`));
}

const runShow = defineCommand({
  meta: { name: "show", description: "Show a run's detail: contract, tasks, amendments" },
  args: { run: { type: "positional", required: true, description: "run id" } },
  run: action(({ args }: { args: Record<string, unknown> }) => {
    db();
    showRun(String(args.run));
  }),
});

const sessionShow = defineCommand({
  meta: { name: "show", description: "Show a session's run/task tree (top-down view)" },
  args: { session: { type: "positional", required: true, description: "session id" } },
  run: action(({ args }: { args: Record<string, unknown> }) => {
    db();
    showSession(String(args.session));
  }),
});

const watch = defineCommand({
  meta: { name: "watch", description: "Live dashboard of runs and agents (Ink)" },
  run: action(async () => {
    const { runWatch } = await import("../src/cli/watch");
    await runWatch();
  }),
});

const runRetry = defineCommand({
  meta: { name: "retry", description: "Retry a run: respawn its supervisor to re-run incomplete tasks" },
  args: { run: { type: "positional", required: true, description: "run id" } },
  run: action(({ args }: { args: Record<string, unknown> }) => {
    db();
    const r = getRun(String(args.run));
    if (!r) throw new Error(`No such run: ${args.run}`);
    if (isAlive(r.supervisor_pid)) {
      throw new Error(`Run ${r.id} is already running (supervisor pid ${r.supervisor_pid}).`);
    }
    if (r.status === "done") return void console.log(pc.yellow("Run is already done."));
    const pid = spawnSupervisor(r.id);
    setSupervisorPid(r.id, pid);
    console.log(pc.green(`Retrying ${pc.bold(r.id)}`) + pc.dim(`  (supervisor pid ${pid})`));
    console.log(pc.dim(`  hermes run logs ${r.id} -f`));
  }),
});

const modelList = defineCommand({
  meta: { name: "list", description: "List configured models" },
  run: action(async () => {
    const config = await loadConfig();
    if (config.models.length === 0) return void console.log(pc.dim("No models configured."));
    for (const m of config.models) {
      const target = m.backend === "anthropic" ? m.apiModelId : m.inferenceProfile;
      console.log(
        `${pc.bold(`${m.name}@${m.version}`)}  ${pc.dim(m.provider)}  ` +
          `runtime=${pc.cyan(m.runtime)} backend=${pc.cyan(m.backend)}  ${pc.dim(target ?? "")}`,
      );
    }
    const roleLine = (label: string, roles: { plannerModel?: string; implementerModel?: string; summaryModel?: string }) =>
      `${label} — planner: ${roles.plannerModel ?? "-"}   ` +
      `implementer: ${roles.implementerModel ?? "-"}   summary: ${roles.summaryModel ?? "-"}`;
    console.log(pc.dim(`\n${roleLine("defaults", config.defaults)}`));
    if (Object.values(config.overrides).some(Boolean)) {
      console.log(pc.dim(`${roleLine("overrides", config.overrides)}  (wins over routing)`));
    }
  }),
});

const ROLE_KEYS: Record<string, ModelRoleKey> = {
  planner: "plannerModel",
  implementer: "implementerModel",
  summary: "summaryModel",
};

/**
 * Builds a `set-default` / `set` command. Both point a role at a registered
 * model; they differ only in which config section they write — `defaults` (the
 * routing fallback) vs. `overrides` (a hard pin that wins over routing).
 */
function definePointerCommand(opts: {
  name: string;
  section: ModelSection;
  /** Noun for messages, e.g. "default" or "override". */
  noun: string;
  description: string;
}) {
  return defineCommand({
    meta: { name: opts.name, description: opts.description },
    args: {
      role: { type: "positional", required: true, description: "planner | implementer | summary" },
      model: {
        type: "positional",
        required: false,
        description: "Registered model (name or name@version). Omit with --clear.",
      },
      clear: {
        type: "boolean",
        default: false,
        description: `Clear this role's ${opts.noun} instead of setting it`,
      },
    },
    run: action(async ({ args }: { args: Record<string, unknown> }) => {
      const role = String(args.role).toLowerCase();
      const key = ROLE_KEYS[role];
      if (!key) {
        throw new Error(`Unknown role "${role}". Use one of: planner, implementer, summary.`);
      }

      if (args.clear) {
        await clearSectionModel(opts.section, key);
        await loadConfig();
        console.log(pc.green(`Cleared ${role} ${opts.noun}`));
        return void console.log(pc.dim(`  ${CONFIG_PATH}`));
      }

      if (!args.model) {
        throw new Error(`A model is required. Usage: hermes model ${opts.name} ${role} <name[@version]>`);
      }
      const ref = String(args.model);
      const config = await loadConfig();
      // Validates the reference exists (throws with the configured list otherwise).
      const resolved = resolveModel(config, ref);
      // The planner and the summary chore both run through the Bedrock Converse path.
      if ((role === "planner" || role === "summary") && resolved.target.kind !== "bedrock") {
        throw new Error(
          `The ${role} model must be bedrock-backed; "${ref}" uses backend "${resolved.backend}".`,
        );
      }

      await setSectionModel(opts.section, key, ref);
      await loadConfig();
      console.log(pc.green(`Set ${role} ${opts.noun} → ${pc.bold(ref)}`));
      console.log(pc.dim(`  ${CONFIG_PATH}`));
    }),
  });
}

const modelSetDefault = definePointerCommand({
  name: "set-default",
  section: "defaults",
  noun: "default",
  description: "Set the fallback planner/implementer/summary model (used when routing has no pick)",
});

const modelSet = definePointerCommand({
  name: "set",
  section: "overrides",
  noun: "override",
  description: "Pin a planner/implementer/summary model, overriding intelligent routing",
});

/** Parses a `--input-price`/`--output-price` string into a nonnegative number. */
function parsePrice(value: unknown, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${flag}: "${String(value)}" (expected a nonnegative number).`);
  }
  return n;
}

const modelAdd = defineCommand({
  meta: {
    name: "add",
    description: "Add a model to the config — auto-resolves its Bedrock inference profile via discovery",
  },
  args: {
    name: { type: "positional", required: true, description: "Friendly model name (e.g. claude-sonnet)" },
    version: { type: "positional", required: true, description: "Version label (e.g. 4.5)" },
    provider: {
      type: "string",
      alias: "p",
      description: "Provider key (anthropic, meta, …). Derived from the matched model when omitted.",
    },
    "model-id": {
      type: "string",
      description: "Exact Bedrock model id to bind (as shown by `hermes model discover`)",
    },
    "inference-profile": {
      type: "string",
      description: "Set the inference-profile id/ARN directly, skipping discovery (escape hatch)",
    },
    "api-model-id": {
      type: "string",
      description: "Use the first-party Anthropic API backend with this model id (no Bedrock; needs ANTHROPIC_API_KEY)",
    },
    "input-price": { type: "string", description: "Pricing: USD per 1M input tokens (hermes runtime)" },
    "output-price": { type: "string", description: "Pricing: USD per 1M output tokens (hermes runtime)" },
    region: { type: "string", description: "AWS region for discovery (defaults to the aws profile's region, AWS_REGION, or us-east-1)" },
    profile: { type: "string", description: "Low-level AWS named profile for discovery (prefer --aws-profile)" },
    "aws-profile": {
      type: "string",
      description: "Config aws-profile key (from `hermes aws list`) this model authenticates through — sets discovery creds/region and tags the entry",
    },
  },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    const name = String(args.name);
    const version = String(args.version);
    const providerFlag = args.provider ? String(args.provider).toLowerCase() : undefined;
    const awsProfileKey = args["aws-profile"] ? String(args["aws-profile"]) : undefined;

    // Resolve the aws-profile key (if given) so discovery authenticates as that
    // account/region and the written entry is tagged with it.
    let awsProfile: ResolvedAwsProfile | undefined;
    if (awsProfileKey) {
      const config = await loadConfig();
      awsProfile = resolveAwsProfile(config.aws, awsProfileKey);
      if (!awsProfile) {
        throw new Error(
          `Unknown aws profile "${awsProfileKey}". Add it with \`hermes aws add\` (see \`hermes aws list\`).`,
        );
      }
    }

    const inputPrice = args["input-price"];
    const outputPrice = args["output-price"];
    let pricing: Pricing | undefined;
    if (inputPrice !== undefined || outputPrice !== undefined) {
      pricing = {
        ...(inputPrice !== undefined ? { inputPer1M: parsePrice(inputPrice, "--input-price") } : {}),
        ...(outputPrice !== undefined ? { outputPer1M: parsePrice(outputPrice, "--output-price") } : {}),
      };
    }

    let entry: ModelInput;
    if (args["api-model-id"]) {
      // First-party Anthropic API backend — no Bedrock discovery needed.
      if (awsProfileKey) {
        throw new Error("--aws-profile doesn't apply to --api-model-id (the anthropic backend uses an API key, not AWS).");
      }
      const provider = providerFlag ?? "anthropic";
      entry = {
        name,
        version,
        provider,
        backend: "anthropic",
        apiModelId: String(args["api-model-id"]),
        ...(pricing ? { pricing } : {}),
      };
    } else if (args["inference-profile"]) {
      // Explicit target — skip discovery. Provider can't be inferred reliably
      // from an inference-profile id (it's prefixed by region), so require it.
      if (!providerFlag) {
        throw new Error("--inference-profile requires --provider (e.g. -p anthropic).");
      }
      entry = {
        name,
        version,
        provider: providerFlag,
        inferenceProfile: String(args["inference-profile"]),
        ...(awsProfileKey ? { awsProfile: awsProfileKey } : {}),
        ...(pricing ? { pricing } : {}),
      };
    } else {
      // The common path: resolve the inference profile automatically. Discovery
      // authenticates as the chosen aws profile (its account/region) so the
      // resolved ARN belongs to the account the model will actually run in.
      const region = (args.region as string | undefined) ?? awsProfile?.region;
      const profile = (args.profile as string | undefined) ?? awsProfile?.profile;
      console.error(
        pc.dim(`# region: ${region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"}`),
      );
      console.error(
        pc.dim(
          `# aws profile: ${awsProfile ? `${awsProfile.key} (${awsProfile.profile})` : profile ?? process.env.AWS_PROFILE ?? "(default provider chain)"}`,
        ),
      );
      // Drive `aws sso login` and assert the account before discovery when bound.
      if (awsProfile) await ensureAuth(awsProfile, { autoLogin: true });
      console.error(pc.dim("# resolving inference profile via Bedrock discovery…"));
      const { resolveBinding } = await import("../src/models/select");
      const binding = await resolveBinding({
        name,
        version,
        provider: providerFlag,
        modelId: args["model-id"] as string | undefined,
        region,
        profile,
      });
      console.error(pc.dim(`# matched ${binding.modelId} → ${binding.inferenceProfile}`));
      entry = {
        name,
        version,
        provider: binding.provider,
        inferenceProfile: binding.inferenceProfile,
        ...(awsProfileKey ? { awsProfile: awsProfileKey } : {}),
        ...(pricing ? { pricing } : {}),
      };
    }

    const added = await addModelToConfig(entry);
    // Re-load so a config that no longer parses surfaces immediately.
    await loadConfig();

    const runtime = added.runtime ?? (added.provider === "anthropic" ? "claude" : "hermes");
    console.log(pc.green(`Added model ${pc.bold(`${added.name}@${added.version}`)}`) + pc.dim(`  ${added.provider}`));
    const target = added.backend === "anthropic" ? added.apiModelId : added.inferenceProfile;
    console.log(pc.dim(`  ${target ?? ""}`));
    if (runtime === "hermes" && !added.pricing) {
      console.log(
        pc.yellow(
          "  note: no pricing set — cost won't be computed for this hermes-runtime model. " +
            "Re-add with --input-price/--output-price.",
        ),
      );
    }
    console.log(pc.dim(`  ${CONFIG_PATH}`));
  }),
});

const modelRemove = defineCommand({
  meta: { name: "remove", description: "Remove a model from the config" },
  args: {
    name: { type: "positional", required: true, description: "Model name" },
    version: { type: "positional", required: false, description: "Version (required when the name has multiple entries)" },
  },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    const removed = await removeModelFromConfig(
      String(args.name),
      args.version ? String(args.version) : undefined,
    );
    console.log(pc.green(`Removed model ${pc.bold(`${removed.name}@${removed.version}`)}`));
    console.log(pc.dim(`  ${CONFIG_PATH}`));
  }),
});

const projectList = defineCommand({
  meta: { name: "list", description: "List configured projects" },
  run: action(async () => {
    const config = await loadConfig();
    if (config.projects.length === 0) return void console.log(pc.dim("No projects configured."));
    for (const p of config.projects) {
      console.log(`${pc.bold(p.name)}  ${pc.dim(p.path)}`);
      console.log(`  ${pc.dim(p.description)}`);
    }
  }),
});

const projectAdd = defineCommand({
  meta: { name: "add", description: "Register a project in the config" },
  args: {
    name: { type: "positional", required: true, description: "Unique project name" },
    path: { type: "positional", required: true, description: "Path to the local repo (git root; ~ ok)" },
    description: {
      type: "string",
      alias: "d",
      description: "What this repo is / does (guides the planner). Auto-generated from README.md/CLAUDE.md if omitted.",
    },
  },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    const path = String(args.path);
    let description = args.description ? String(args.description) : "";
    if (!description) {
      // Fall back to summarizing the repo's docs with the cheap summary model.
      const config = await loadConfig();
      console.log(pc.dim("No --description given; summarizing README.md / CLAUDE.md…"));
      description = await generateProjectDescription(config, path);
      console.log(pc.dim(`  ${description}`));
    }
    const p = await addProjectToConfig({
      name: String(args.name),
      path,
      description,
    });
    // Re-load so an invalid config (bad path, etc.) surfaces immediately.
    await loadConfig();
    console.log(pc.green(`Added project ${pc.bold(p.name)}`) + pc.dim(`  ${p.path}`));
    console.log(pc.dim(`  ${CONFIG_PATH}`));
  }),
});

const projectRemove = defineCommand({
  meta: { name: "remove", description: "Remove a project from the config" },
  args: { name: { type: "positional", required: true, description: "Project name" } },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    const p = await removeProjectFromConfig(String(args.name));
    console.log(pc.green(`Removed project ${pc.bold(p.name)}`) + pc.dim(`  ${p.path}`));
    console.log(pc.dim(`  ${CONFIG_PATH}`));
  }),
});

const modelDiscover = defineCommand({
  meta: {
    name: "discover",
    description: "Discover Bedrock chat models your AWS identity can invoke (+ their inference-profile target)",
  },
  args: {
    profile: { type: "string", description: "Low-level AWS named profile (defaults to the standard provider chain / AWS_PROFILE)" },
    region: { type: "string", description: "AWS region (defaults to AWS_REGION or us-east-1)" },
    "aws-profile": {
      type: "string",
      description: "Config aws-profile key (from `hermes aws list`) to explore — sets creds + region from it",
    },
    "profile-prefix": {
      type: "string",
      description: "Only pick application profiles whose name/id contains this substring",
    },
    top: { type: "string", description: "Max models to show per provider (default: all)" },
    "ready-only": { type: "boolean", default: false, description: "Only show models with a ready invocation target" },
    verify: {
      type: "boolean",
      default: false,
      description: "Actually invoke each model to confirm it works for this profile (real, billable calls)",
    },
    json: { type: "boolean", default: false, description: "Emit raw JSON instead of the grouped view" },
  },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    const { discoverModels, groupByProvider } = await import("../src/models/discover");

    // A config aws-profile key supplies creds + region; explicit --profile/--region override.
    let awsProfile: ResolvedAwsProfile | undefined;
    if (args["aws-profile"]) {
      const config = await loadConfig();
      awsProfile = resolveAwsProfile(config.aws, String(args["aws-profile"]));
      if (!awsProfile) throw new Error(`Unknown aws profile "${String(args["aws-profile"])}".`);
    }
    const region = (args.region as string | undefined) ?? awsProfile?.region;
    const profile = (args.profile as string | undefined) ?? awsProfile?.profile;

    console.error(pc.dim(`# region: ${region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"}`));
    console.error(
      pc.dim(
        `# aws profile: ${awsProfile ? `${awsProfile.key} (${awsProfile.profile})` : profile ?? process.env.AWS_PROFILE ?? "(default provider chain)"}`,
      ),
    );

    let models = await discoverModels({
      region,
      profile,
      profilePrefix: args["profile-prefix"] as string | undefined,
    });
    if (args["ready-only"]) models = models.filter((m) => m.status === "READY");

    if (args.verify && models.length > 0) {
      const { verifyModels } = await import("../src/models/verify");
      console.error(
        pc.dim(`# verifying ${models.length} model(s) with a minimal invocation (real, billable calls)…`),
      );
      models = await verifyModels(models, {
        region,
        profile,
        onProgress: (done, total, m) => {
          const mark = m.verification?.ok ? pc.green("ok") : pc.red("FAIL");
          process.stderr.write(pc.dim(`  [${done}/${total}] ${mark} ${m.modelId}\n`));
        },
      });
    }

    if (args.json) {
      console.log(JSON.stringify(models, null, 2));
      return;
    }

    if (models.length === 0) {
      return void console.log(pc.dim("No matching Bedrock chat models found for this identity."));
    }

    const top = args.top ? parseInt(String(args.top), 10) : 0;
    const grouped = groupByProvider(models);
    let ready = 0;
    let verifiedOk = 0;
    for (const [provider, list] of grouped) {
      console.log(`\n${pc.bold(provider)}:`);
      for (const m of top > 0 ? list.slice(0, top) : list) {
        if (m.status === "READY") ready++;
        if (m.verification?.ok) verifiedOk++;
        const status =
          m.status === "READY"
            ? pc.green(m.status)
            : m.status === "MULTIPLE_APPLICATION_PROFILES"
              ? pc.yellow(m.status)
              : pc.dim(m.status);
        const verify = m.verification
          ? "  " + (m.verification.ok ? pc.green("✓ works") : pc.red("✗ fails"))
          : "";
        console.log(`  ${m.modelId}  ${status}${verify}`);
        if (m.transport === "mantle") {
          console.log(`    ${pc.dim("mantle endpoint:")} ${m.endpoint}  ${pc.dim(`(${m.source})`)}`);
        } else {
          console.log(`    ${pc.dim("inferenceProfile:")} ${m.target}  ${pc.dim(`(${m.source})`)}`);
        }
        if (m.candidates.length > 0) {
          console.log(pc.dim(`    candidates: ${m.candidates.join(", ")}`));
        }
        if (m.verification && !m.verification.ok) {
          console.log(pc.dim(`    reason: ${m.verification.detail}`));
        }
      }
    }
    const verifyNote = args.verify
      ? ` ${verifiedOk} verified working.`
      : " Add --verify to confirm which actually work for this profile.";
    console.log(
      pc.dim(
        `\n${ready} ready to use.${verifyNote} Add one with \`hermes model add <name> <version> --model-id <id>\`` +
          ` — the inference profile is resolved for you. Mantle entries are gateway-only (DISCOVERED_NOT_VALIDATED).`,
      ),
    );
  }),
});

const model = defineCommand({
  meta: { name: "model", description: "Model registry" },
  subCommands: {
    list: modelList,
    discover: modelDiscover,
    add: modelAdd,
    remove: modelRemove,
    "set-default": modelSetDefault,
    set: modelSet,
  },
});

// --- aws: named account/region/profile identities models authenticate through ---

const awsList = defineCommand({
  meta: { name: "list", description: "List configured AWS profiles (account/region) and which models use them" },
  run: action(async () => {
    const config = await loadConfig();
    const keys = Object.keys(config.aws.profiles);
    if (keys.length === 0) {
      return void console.log(
        pc.dim("No AWS profiles configured. Add one with `hermes aws add <key> --profile <name>`."),
      );
    }
    for (const key of keys) {
      const p = config.aws.profiles[key]!;
      const isDefault = config.aws.default === key ? pc.green(" (default)") : "";
      const users = config.models
        .filter((m) => (m.awsProfile ?? config.aws.default) === key && m.backend === "bedrock")
        .map((m) => `${m.name}@${m.version}`);
      console.log(`${pc.bold(key)}${isDefault}  ${pc.dim(p.profile)}`);
      console.log(
        pc.dim(`  account: ${p.account ?? "(unset)"}   region: ${p.region ?? "(env/us-east-1)"}`),
      );
      console.log(pc.dim(`  models: ${users.join(", ") || "(none)"}`));
    }
  }),
});

/** Prints a resolved caller identity, flagging whether it matches the expected account. */
function printIdentity(profile: ResolvedAwsProfile, identity: { account: string; arn: string }): void {
  const match =
    profile.account && identity.account
      ? identity.account === profile.account
        ? pc.green(" ✓ matches config")
        : pc.red(` ✗ expected ${profile.account}`)
      : "";
  console.log(`${pc.bold(profile.key)}  ${pc.dim(profile.profile)}`);
  console.log(pc.dim(`  account: ${identity.account}`) + match);
  console.log(pc.dim(`  arn: ${identity.arn}`));
}

const awsAdd = defineCommand({
  meta: { name: "add", description: "Add a named AWS profile (account/region/profile) for models to authenticate through" },
  args: {
    key: { type: "positional", required: true, description: "Config key models reference (e.g. coding-tools)" },
    profile: { type: "string", required: true, description: "AWS shared-config profile name (e.g. coding-tools-aws-coding-tools-bedrock)" },
    account: { type: "string", description: "Expected 12-digit AWS account id (auto-filled from --login when omitted)" },
    region: { type: "string", description: "Region the inference profiles live in (e.g. us-east-1)" },
    default: { type: "boolean", default: false, description: "Make this the default profile for models that don't name one" },
    login: {
      type: "boolean",
      default: false,
      description: "Drive `aws sso login`, verify the identity, and auto-fill --account from it",
    },
  },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    const key = String(args.key);
    const profileName = String(args.profile);
    const region = args.region ? String(args.region) : undefined;
    let account = args.account ? String(args.account) : undefined;
    if (account && !/^\d{12}$/.test(account)) {
      throw new Error(`Invalid --account "${account}": expected a 12-digit AWS account id.`);
    }

    if (args.login) {
      // Verify (logging in if needed) so we can confirm — and, when omitted,
      // discover — the account before writing it.
      const resolved: ResolvedAwsProfile = { key, profile: profileName, account, region };
      const identity = await ensureAuth(resolved, { autoLogin: true });
      if (!account) {
        account = identity.account;
        console.error(pc.dim(`# discovered account ${account} for profile ${profileName}`));
      }
    }

    const profile: AwsProfile = {
      profile: profileName,
      ...(account ? { account } : {}),
      ...(region ? { region } : {}),
    };
    const { isDefault } = await addAwsProfileToConfig(key, profile, { makeDefault: Boolean(args.default) });
    await loadConfig(); // surface a config that no longer parses
    console.log(pc.green(`Added aws profile ${pc.bold(key)}`) + (isDefault ? pc.green(" (default)") : ""));
    console.log(pc.dim(`  profile: ${profileName}   account: ${account ?? "(unset)"}   region: ${region ?? "(env/us-east-1)"}`));
    console.log(pc.dim(`  ${CONFIG_PATH}`));
    if (!account) {
      console.log(pc.yellow("  note: no account set — hermes can't verify this profile points at the right account. Re-run with --login or --account."));
    }
  }),
});

const awsRemove = defineCommand({
  meta: { name: "remove", description: "Remove a configured AWS profile" },
  args: { key: { type: "positional", required: true, description: "Profile key to remove" } },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    const removed = await removeAwsProfileFromConfig(String(args.key));
    console.log(pc.green(`Removed aws profile ${pc.bold(String(args.key))}`) + pc.dim(`  ${removed.profile}`));
    console.log(pc.dim(`  ${CONFIG_PATH}`));
  }),
});

const awsSetDefault = defineCommand({
  meta: { name: "set-default", description: "Set (or --clear) the default AWS profile for models that don't name one" },
  args: {
    key: { type: "positional", required: false, description: "Profile key to make default (omit with --clear)" },
    clear: { type: "boolean", default: false, description: "Clear the default instead of setting it" },
  },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    if (args.clear) {
      await setDefaultAwsProfile(null);
      await loadConfig();
      console.log(pc.green("Cleared default aws profile"));
      return void console.log(pc.dim(`  ${CONFIG_PATH}`));
    }
    if (!args.key) throw new Error("A profile key is required. Usage: hermes aws set-default <key> (or --clear).");
    await setDefaultAwsProfile(String(args.key));
    await loadConfig();
    console.log(pc.green(`Set default aws profile → ${pc.bold(String(args.key))}`));
    console.log(pc.dim(`  ${CONFIG_PATH}`));
  }),
});

const awsLogin = defineCommand({
  meta: { name: "login", description: "Sign in to an AWS profile (or all of them) via `aws sso login` and verify the identity" },
  args: { key: { type: "positional", required: false, description: "Profile key (omit to log in to every configured profile)" } },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    const config = await loadConfig();
    const keys = args.key ? [String(args.key)] : Object.keys(config.aws.profiles);
    if (keys.length === 0) {
      return void console.log(pc.dim("No AWS profiles configured. Add one with `hermes aws add`."));
    }
    for (const key of keys) {
      const resolved = resolveAwsProfile(config.aws, key);
      if (!resolved) throw new Error(`Unknown aws profile "${key}".`);
      const identity = await ensureAuth(resolved, { autoLogin: true });
      printIdentity(resolved, identity);
    }
  }),
});

const awsWhoami = defineCommand({
  meta: { name: "whoami", description: "Verify AWS identity for a profile (or all) without logging in — checks the account matches" },
  args: { key: { type: "positional", required: false, description: "Profile key (omit to check every configured profile)" } },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    const config = await loadConfig();
    const keys = args.key ? [String(args.key)] : Object.keys(config.aws.profiles);
    if (keys.length === 0) {
      return void console.log(pc.dim("No AWS profiles configured. Add one with `hermes aws add`."));
    }
    let failed = false;
    for (const key of keys) {
      const resolved = resolveAwsProfile(config.aws, key);
      if (!resolved) throw new Error(`Unknown aws profile "${key}".`);
      try {
        const identity = await ensureAuth(resolved, { autoLogin: false });
        printIdentity(resolved, identity);
      } catch (err) {
        failed = true;
        console.log(`${pc.bold(key)}  ${pc.dim(resolved.profile)}`);
        console.log(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    if (failed) process.exit(1);
  }),
});

const aws = defineCommand({
  meta: { name: "aws", description: "AWS profiles — the accounts/regions models authenticate through" },
  subCommands: {
    list: awsList,
    add: awsAdd,
    remove: awsRemove,
    "set-default": awsSetDefault,
    login: awsLogin,
    whoami: awsWhoami,
  },
});

const project = defineCommand({
  meta: { name: "project", description: "Project registry" },
  subCommands: { list: projectList, add: projectAdd, remove: projectRemove },
});

// Internal: the detached per-run supervisor entrypoint. `spawnSupervisor`
// re-invokes this program as `hermes __supervise <runId>` so a single (possibly
// compiled) binary serves both the CLI and the background supervisor.
const superviseCmd = defineCommand({
  meta: { name: "__supervise", description: "(internal) run a run's supervisor", hidden: true },
  args: { run: { type: "positional", required: true, description: "run id" } },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    await supervise(String(args.run));
  }),
});

// The three model concepts are the top-level nouns; each groups the verbs that
// act on it. `init`/`watch` are cross-cutting, and `model`/`project` are the
// config registries.
const session = defineCommand({
  meta: { name: "session", description: "Planning sessions — the primary interface" },
  subCommands: { start: sessionStart, list: sessionList, show: sessionShow },
});

const run = defineCommand({
  meta: { name: "run", description: "Runs — a batch of coordinated work fanned out across projects" },
  subCommands: { list: runList, show: runShow, logs: runLogs, stop: runStop, retry: runRetry },
});

const task = defineCommand({
  meta: { name: "task", description: "Tasks — one project's slice of a run" },
  subCommands: { list: taskList, logs: taskLogs },
});

const subCommands = {
  session,
  run,
  task,
  init,
  watch,
  model,
  project,
  aws,
  __supervise: superviseCmd,
};

const main = defineCommand({
  meta: { name: "hermes", description: "Personal local development harness" },
  subCommands,
});

// The primary interface is the planning session: a bare `hermes` (or one with
// only leading flags, e.g. `hermes --resume <id>`) starts one. We inject
// `session start` rather than using citty's parent `run`, because citty always
// runs a command's `run` *in addition to* any matched subcommand.
const rawArgs = process.argv.slice(2);
const wantsMeta = rawArgs.some((a) => a === "--help" || a === "-h" || a === "--version");
const noSubCommand = rawArgs.length === 0 || (rawArgs[0]?.startsWith("-") ?? false);
if (!wantsMeta && noSubCommand) {
  process.argv.splice(2, 0, "session", "start");
}

runMain(main);
