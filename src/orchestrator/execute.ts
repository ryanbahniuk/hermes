import type { HermesConfig, Pricing } from "../config/schema";
import { resolveModel, type ResolvedModel } from "../models/registry";
import { selectRuntime } from "../runtimes";
import { ensureWorktree, removeWorktree, type Worktree } from "../worktree/worktree";
import {
  createAmendment,
  getRun,
  getSharedContext,
  putSharedContext,
  resolveAmendment,
  setResumeRef,
  setTaskCost,
  setTaskStatus,
  type TaskRow,
} from "../db";
import type { Coordination } from "../runtimes/types";
import { adjudicate } from "./adjudicate";
import { appendLog, taskLogFile } from "../logging/logs";

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TaskOutcome {
  status: "done" | "failed";
  summary: string;
  tokens: TokenTotals;
  cost: number;
  costSource: "runtime" | "pricing" | "none";
  worktree: Worktree | undefined;
}

/** Cost in USD from token totals and per-1M pricing. */
export function costFromPricing(pricing: Pricing, t: TokenTotals): number {
  const per = (tokens: number, price?: number) => (price ? (tokens / 1_000_000) * price : 0);
  return (
    per(t.input, pricing.inputPer1M) +
    per(t.output, pricing.outputPer1M) +
    per(t.cacheRead, pricing.cacheReadPer1M) +
    per(t.cacheWrite, pricing.cacheWritePer1M)
  );
}

/**
 * Executes one existing task row to completion: worktree → runtime → stream →
 * persist tokens/cost/status. The reusable core for both `hermes agent`
 * (foreground) and the detached supervisor.
 */
export async function executeTask(
  config: HermesConfig,
  task: TaskRow,
  opts: { keepWorktree?: boolean; onEvent?: (line: string) => void; adjudicator?: ResolvedModel } = {},
  preResolved?: ResolvedModel,
): Promise<TaskOutcome> {
  const project = config.projects.find((p) => p.name === task.project_name);
  if (!project) throw new Error(`Unknown project "${task.project_name}" for task ${task.id}`);
  if (!task.model) throw new Error(`task ${task.id} has no model`);
  const prompt = task.prompt ?? "";
  const model = preResolved ?? resolveModel(config, task.model);

  const logFile = taskLogFile(task.run_id, task.id);
  const emit = (line: string) => {
    appendLog(logFile, line);
    opts.onEvent?.(line);
  };

  setTaskStatus(task.id, "implementing");
  emit(`project=${project.name} model=${task.model} runtime=${model.runtime} backend=${model.backend}`);

  const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let runtimeCost: number | undefined;
  let summary = "";
  let failure: string | undefined;
  let worktree: Worktree | undefined;

  try {
    worktree = ensureWorktree(project.path, task.run_id, project.name);
    emit(`worktree: ${worktree.path} (branch ${worktree.branch})`);

    const runtime = selectRuntime(model);
    const scoping = { worktree: worktree.path, readAllowlist: config.readAllowlist };

    // Coordination tools: read the latest shared context; propose_amendment is
    // adjudicated live by the powerful model (accept → version-bump; reject → conform).
    const coordination: Coordination = {
      readSharedContext: () => getSharedContext(task.run_id)?.content ?? "",
      proposeAmendment: async (proposal) => {
        const amendment = createAmendment({ runId: task.run_id, taskId: task.id, proposal });
        emit(`amendment proposed: ${proposal.replace(/\s+/g, " ").slice(0, 160)}`);
        if (!opts.adjudicator) {
          return "Amendment recorded; the supervisor will review it later. Keep conforming to the current contract.";
        }
        try {
          const problem = getRun(task.run_id)?.problem ?? prompt;
          const currentContext = getSharedContext(task.run_id)?.content ?? "";
          const verdict = await adjudicate(opts.adjudicator, { problem, currentContext, proposal });
          if (verdict.decision === "accept" && verdict.updatedContext) {
            const version = putSharedContext(task.run_id, verdict.updatedContext, `amend:${task.id}`);
            resolveAmendment(amendment.id, "accepted", verdict.reason);
            emit(`amendment ACCEPTED → shared context v${version}: ${verdict.reason.slice(0, 120)}`);
            return `Accepted. The shared context is now:\n${verdict.updatedContext}\n\nConform to this updated contract.`;
          }
          resolveAmendment(amendment.id, "rejected", verdict.reason);
          emit(`amendment REJECTED: ${verdict.reason.slice(0, 120)}`);
          return `Rejected: ${verdict.reason}\nConform to the current shared contract.`;
        } catch (err) {
          emit(`adjudication unavailable (${(err as Error).message}); amendment left queued`);
          return "Amendment recorded, but adjudication is unavailable right now. Keep conforming to the current contract.";
        }
      },
    };

    for await (const ev of runtime.run({
      taskId: task.id,
      runId: task.run_id,
      prompt,
      cwd: worktree.path,
      model,
      scoping,
      sharedContext: getSharedContext(task.run_id)?.content ?? "",
      coordination,
    })) {
      switch (ev.type) {
        case "text":
          emit(`assistant: ${ev.text}`);
          break;
        case "tool_call":
          emit(`→ ${ev.tool}(${JSON.stringify(ev.input)})`);
          break;
        case "tool_result":
          emit(`← ${ev.tool} ${ev.ok ? "ok" : "ERR"}: ${ev.preview.replace(/\s+/g, " ")}`);
          break;
        case "usage":
          tokens.input += ev.inputTokens;
          tokens.output += ev.outputTokens;
          tokens.cacheRead += ev.cacheReadTokens;
          tokens.cacheWrite += ev.cacheWriteTokens;
          break;
        case "cost":
          runtimeCost = ev.usd;
          break;
        case "session":
          setResumeRef(task.id, ev.ref);
          break;
        case "log":
          emit(ev.message);
          break;
        case "done":
          summary = ev.summary;
          break;
        case "error":
          failure = ev.message;
          emit(`ERROR: ${ev.message}`);
          break;
      }
      if (failure) break;
    }
  } catch (err) {
    failure = (err as Error).message;
    emit(`ERROR: ${failure}`);
  } finally {
    if (worktree && !opts.keepWorktree) {
      try {
        removeWorktree(worktree);
        emit(`worktree removed`);
      } catch (err) {
        emit(`worktree cleanup failed: ${(err as Error).message}`);
      }
    }
  }

  let cost = 0;
  let costSource: TaskOutcome["costSource"] = "none";
  if (runtimeCost !== undefined) {
    cost = runtimeCost;
    costSource = "runtime";
  } else if (model.pricing) {
    cost = costFromPricing(model.pricing, tokens);
    costSource = "pricing";
  }
  setTaskCost(task.id, cost);

  const status: TaskOutcome["status"] = failure ? "failed" : "done";
  setTaskStatus(task.id, status);
  emit(
    `done. tokens in=${tokens.input} out=${tokens.output} ` +
      `cacheR=${tokens.cacheRead} cacheW=${tokens.cacheWrite} ` +
      `cost=$${cost.toFixed(4)} (${costSource}) status=${status}`,
  );

  return { status, summary, tokens, cost, costSource, worktree };
}
