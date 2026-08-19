#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { loadConfig } from "../src/config/load";
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
