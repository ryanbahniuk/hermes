#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { loadConfig } from "../src/config/load";
import {
  db,
  createRun,
  createTask,
  listRuns,
  listTasks,
  getRun,
  getTask,
  getSharedContext,
  listAmendments,
  setSupervisorPid,
} from "../src/db";
import { resolveModel } from "../src/models/registry";
import { spawnSupervisor, isAlive } from "../src/process/spawn";
import { followLog, readLog, runLogFile, taskLogFile } from "../src/logging/logs";
import { initHome } from "../src/init";
import { runSingleTask } from "../src/orchestrator/single";

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

const run = defineCommand({
  meta: { name: "run", description: "Kick off a run (async)" },
  args: {
    problem: { type: "positional", required: true, description: "Problem statement (quote it)" },
    projects: { type: "string", description: "Comma-separated project names (skip planner)" },
    model: { type: "string", description: "Planner model name (or name@version)" },
    backend: { type: "string", description: "Backend override: bedrock | anthropic" },
  },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    const config = await loadConfig();
    db();

    const problem = String(args.problem);
    const projectsArg = args.projects as string | undefined;

    // Planner model reference (also drives implementers when --projects is used).
    const plannerRef =
      (args.model as string | undefined) ?? config.defaults.plannerModel;
    if (!plannerRef) throw new Error(`No model given and no defaults.plannerModel configured.`);
    // Validate it resolves (and any --backend override).
    resolveModel(config, plannerRef, args.backend as "bedrock" | "anthropic" | undefined);

    const r = createRun({ problem, plannerModel: plannerRef });

    let note: string;
    if (projectsArg) {
      // Explicit selection: skip the planner, create a task per project now.
      const names = projectsArg.split(",").map((s) => s.trim()).filter(Boolean);
      for (const n of names) {
        if (!config.projects.find((p) => p.name === n)) {
          const known = config.projects.map((p) => p.name).join(", ") || "(none)";
          throw new Error(`Unknown project "${n}". Configured: ${known}`);
        }
      }
      const implRef =
        (args.model as string | undefined) ??
        config.defaults.implementerModel ??
        config.defaults.plannerModel!;
      const implModel = resolveModel(config, implRef, args.backend as "bedrock" | "anthropic" | undefined);
      const implLabel = `${implModel.name}@${implModel.version}`;
      for (const n of names) {
        createTask({ runId: r.id, projectName: n, model: implLabel, runtime: implModel.runtime, prompt: problem });
      }
      note = `${names.length} task(s)`;
    } else {
      // No selection: the supervisor's planner will choose projects.
      note = "planner will select projects";
    }

    const pid = spawnSupervisor(r.id);
    setSupervisorPid(r.id, pid);
    console.log(pc.green(`Started ${pc.bold(r.id)}`) + pc.dim(`  (supervisor pid ${pid}, ${note})`));
    console.log(pc.dim(`  hermes logs ${r.id} -f`));
  }),
});

const agent = defineCommand({
  meta: { name: "agent", description: "Run a single project agent in the foreground (dev)" },
  args: {
    problem: { type: "positional", required: true, description: "Problem statement (quote it)" },
    project: { type: "string", required: true, description: "Project name from your config" },
    model: { type: "string", description: "Model name (or name@version)" },
    backend: { type: "string", description: "Backend override: bedrock | anthropic" },
    keep: { type: "boolean", default: false, description: "Keep the worktree after finishing" },
  },
  run: action(async ({ args }: { args: Record<string, unknown> }) => {
    const config = await loadConfig();
    db();
    const res = await runSingleTask({
      config,
      projectName: String(args.project),
      problem: String(args.problem),
      modelRef: args.model as string | undefined,
      backend: args.backend as "bedrock" | "anthropic" | undefined,
      keepWorktree: Boolean(args.keep),
      onEvent: (line) => console.log(pc.dim(line)),
    });
    console.log();
    console.log(
      pc.green(`✓ ${res.runId} / ${res.taskId}`) +
        pc.dim(
          `  (in=${res.tokens.input} out=${res.tokens.output} cacheR=${res.tokens.cacheRead} cacheW=${res.tokens.cacheWrite}, ` +
            `$${res.cost.toFixed(4)} ${res.costSource})`,
        ),
    );
    console.log(pc.bold("Summary: ") + res.summary);
    if (args.keep && res.worktree) console.log(pc.dim(`worktree kept: ${res.worktree.path}`));
  }),
});

const runs = defineCommand({
  meta: { name: "runs", description: "List runs" },
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

const ps = defineCommand({
  meta: { name: "ps", description: "List tasks/agents" },
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

const logs = defineCommand({
  meta: { name: "logs", description: "Show run/task logs" },
  args: {
    target: { type: "positional", required: true, description: "run id or task id" },
    follow: { type: "boolean", alias: "f", default: false, description: "Follow output" },
  },
  run: action(({ args }: { args: Record<string, unknown> }) => {
    db();
    const target = String(args.target);
    let file: string;
    if (target.startsWith("task_")) {
      const t = getTask(target);
      if (!t) throw new Error(`No such task: ${target}`);
      file = taskLogFile(t.run_id, t.id);
    } else {
      if (!getRun(target)) throw new Error(`No such run: ${target}`);
      file = runLogFile(target);
    }
    if (args.follow) return followLog(file);
    process.stdout.write(readLog(file));
  }),
});

const stop = defineCommand({
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

const show = defineCommand({
  meta: { name: "show", description: "Show run detail: contract, tasks, amendments" },
  args: { run: { type: "positional", required: true, description: "run id" } },
  run: action(({ args }: { args: Record<string, unknown> }) => {
    db();
    const r = getRun(String(args.run));
    if (!r) throw new Error(`No such run: ${args.run}`);

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
  }),
});

const watch = defineCommand({
  meta: { name: "watch", description: "Live dashboard of runs and agents (Ink)" },
  run: action(async () => {
    const { runWatch } = await import("../src/cli/watch");
    await runWatch();
  }),
});

const resume = defineCommand({
  meta: { name: "resume", description: "Resume a run: re-run its incomplete tasks" },
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
    console.log(pc.green(`Resumed ${pc.bold(r.id)}`) + pc.dim(`  (supervisor pid ${pid})`));
    console.log(pc.dim(`  hermes logs ${r.id} -f`));
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

const model = defineCommand({
  meta: { name: "model", description: "Model registry" },
  subCommands: { list: modelList },
});

const project = defineCommand({
  meta: { name: "project", description: "Project registry" },
  subCommands: { list: projectList },
});

const main = defineCommand({
  meta: { name: "hermes", description: "Personal local development harness" },
  subCommands: { init, run, agent, runs, ps, logs, stop, resume, show, watch, model, project },
});

runMain(main);
