import type { HermesConfig } from "../config/schema";
import { resolveModel } from "../models/registry";
import { db, createRun, createTask, setRunCost, setRunStatus } from "../db";
import { executeTask, type TokenTotals } from "./execute";
import type { Worktree } from "../worktree/worktree";

export interface SingleTaskOptions {
  config: HermesConfig;
  projectName: string;
  problem: string;
  modelRef?: string;
  backend?: "bedrock" | "anthropic";
  keepWorktree?: boolean;
  onEvent?: (line: string) => void;
}

export interface SingleTaskResult {
  runId: string;
  taskId: string;
  worktree: Worktree | undefined;
  summary: string;
  tokens: TokenTotals;
  cost: number;
  costSource: "runtime" | "pricing" | "none";
}

/**
 * Runs one project agent to completion in the foreground (used by `hermes agent`).
 * Creates its own single-task run, then delegates to executeTask.
 */
export async function runSingleTask(opts: SingleTaskOptions): Promise<SingleTaskResult> {
  db();

  const project = opts.config.projects.find((p) => p.name === opts.projectName);
  if (!project) {
    const known = opts.config.projects.map((p) => p.name).join(", ") || "(none)";
    throw new Error(`Unknown project "${opts.projectName}". Configured: ${known}`);
  }

  const modelRef =
    opts.modelRef ?? opts.config.defaults.implementerModel ?? opts.config.defaults.plannerModel;
  if (!modelRef) {
    throw new Error(`No model given and no defaults.implementerModel/plannerModel configured.`);
  }
  const model = resolveModel(opts.config, modelRef, opts.backend);
  const label = `${model.name}@${model.version}`;

  const run = createRun({ problem: opts.problem, plannerModel: label });
  setRunStatus(run.id, "implementing");
  const task = createTask({
    runId: run.id,
    projectName: project.name,
    model: label,
    runtime: model.runtime,
    prompt: opts.problem,
  });

  const outcome = await executeTask(
    opts.config,
    task,
    { keepWorktree: opts.keepWorktree, onEvent: opts.onEvent, adjudicator: model },
    model,
  );

  setRunCost(run.id, outcome.cost);
  setRunStatus(run.id, outcome.status === "failed" ? "failed" : "done");

  return {
    runId: run.id,
    taskId: task.id,
    worktree: outcome.worktree,
    summary: outcome.summary,
    tokens: outcome.tokens,
    cost: outcome.cost,
    costSource: outcome.costSource,
  };
}
