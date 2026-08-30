import { loadConfig } from "../config/load";
import { ensureAuth } from "../models/aws";
import { resolveModel, type ResolvedModel } from "../models/registry";
import { effectiveModelRef } from "../models/routing";
import {
  db,
  createTask,
  getRun,
  getSharedContext,
  listTasks,
  putSharedContext,
  setRunCost,
  setRunStatus,
  setSupervisorPid,
} from "../db";
import { appendLog, runLogFile } from "../logging/logs";
import { executeTask } from "./execute";
import { plan } from "./plan";
import { reconcile } from "./reconcile";

/**
 * The detached supervisor body: owns a run end-to-end.
 *   plan (if no tasks yet) → author shared context → fan out implementers in
 *   parallel → reconcile → roll up.
 * Live amendment adjudication lands in step 7.
 */
export async function supervise(runId: string): Promise<void> {
  db();
  const runLog = runLogFile(runId);
  appendLog(runLog, `supervisor started (pid ${process.pid})`);

  const run = getRun(runId);
  if (!run) {
    appendLog(runLog, `no such run: ${runId}`);
    return;
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    appendLog(runLog, `config error: ${(err as Error).message}`);
    setRunStatus(runId, "failed");
    setSupervisorPid(runId, null);
    return;
  }

  appendLog(runLog, `problem: ${run.problem}`);

  try {
    // --- Plan phase: only if no tasks were pre-selected (`run --projects`). ---
    if (listTasks(runId).length === 0) {
      setRunStatus(runId, "planning");
      const plannerRef = run.planner_model ?? effectiveModelRef(config, "planner");
      if (!plannerRef) throw new Error(`no planner model configured`);
      const plannerModel = resolveModel(config, plannerRef);

      // Confirm the planner's AWS profile is authenticated and on the expected
      // account before spending. No TTY here (detached supervisor), so no auto-
      // login — a stale session fails with a `tack aws login` hint.
      if (plannerModel.aws) await ensureAuth(plannerModel.aws);

      appendLog(runLog, `planning with ${plannerRef}…`);
      const { selections, sharedContext } = await plan(config, plannerModel, run.problem);

      if (sharedContext.trim()) {
        const version = putSharedContext(runId, sharedContext, "planner");
        appendLog(runLog, `planner authored shared context v${version}`);
      }

      const implRef = effectiveModelRef(config, "implementer") ?? plannerRef;
      const implModel = resolveModel(config, implRef);
      const implLabel = `${implModel.name}@${implModel.version}`;

      // Same preflight for the implementer's profile — it may be a different
      // account than the planner's. Fail before creating tasks we can't run.
      if (implModel.aws) await ensureAuth(implModel.aws);

      for (const s of selections) {
        createTask({
          runId,
          projectName: s.project,
          model: implLabel,
          runtime: implModel.runtime,
          prompt: s.subtask,
        });
      }
      appendLog(
        runLog,
        `planner selected ${selections.length} project(s): ${selections.map((s) => s.project).join(", ") || "(none)"}`,
      );
    }
  } catch (err) {
    appendLog(runLog, `planning failed: ${(err as Error).message}`);
    setRunStatus(runId, "failed");
    setSupervisorPid(runId, null);
    return;
  }

  // Ensure a shared context exists even on the explicit `--projects` path.
  if (!getSharedContext(runId)) {
    putSharedContext(runId, run.problem, "run");
  }

  // Adjudicator for live amendment proposals: the powerful (planner) model.
  let adjudicator: ResolvedModel | undefined;
  const adjRef = effectiveModelRef(config, "planner") ?? run.planner_model;
  if (adjRef) {
    try {
      adjudicator = resolveModel(config, adjRef);
    } catch {
      adjudicator = undefined;
    }
  }

  // --- Implement phase: run all non-terminal tasks in parallel. ---
  setRunStatus(runId, "implementing");
  const pending = listTasks(runId).filter((t) => t.status !== "done");
  appendLog(runLog, `executing ${pending.length} task(s) in parallel`);

  const statuses = await Promise.all(
    pending.map(async (task) => {
      appendLog(runLog, `task ${task.id} (${task.project_name}) starting`);
      try {
        const outcome = await executeTask(config, task, { keepWorktree: true, adjudicator });
        appendLog(runLog, `task ${task.id} ${outcome.status} cost=$${outcome.cost.toFixed(4)}`);
        return outcome.status;
      } catch (err) {
        appendLog(runLog, `task ${task.id} error: ${(err as Error).message}`);
        return "failed" as const;
      }
    }),
  );

  // --- Reconcile phase: summarize changes vs the contract, surface amendments. ---
  setRunStatus(runId, "reconciling");
  const report = reconcile(runId);
  for (const line of report.split("\n")) appendLog(runLog, line);

  const anyFailed = statuses.includes("failed");
  const totalCost = listTasks(runId).reduce((sum, t) => sum + t.cost, 0);
  setRunCost(runId, totalCost);
  setRunStatus(runId, anyFailed ? "failed" : "done");
  setSupervisorPid(runId, null);
  appendLog(
    runLog,
    `supervisor finished: ${anyFailed ? "failed" : "done"} totalCost=$${totalCost.toFixed(4)}`,
  );
}
