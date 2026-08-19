import type { HermesConfig } from "../config/schema";
import { resolveModel } from "../models/registry";
import {
  createRun,
  createTask,
  listRunsBySession,
  listTasks,
  putSharedContext,
  setSupervisorPid,
} from "../db";
import { isAlive, spawnSupervisor } from "../process/spawn";

/** One project's slice of a delegated run, as chosen by the planner. */
export interface DelegateProject {
  name: string;
  subtask: string;
}

export interface DelegateInput {
  /** The refined problem statement handed to the worker swarm. */
  problem: string;
  /**
   * Explicit project selection. When omitted (or empty), the supervisor's own
   * planner selects projects from the registry and authors subtasks.
   */
  projects?: DelegateProject[];
  /** Optional cross-project contract every worker must conform to. */
  sharedContext?: string;
}

/**
 * The capabilities a planner agent may invoke. The planner never edits code — it
 * inspects (read-only tools, elsewhere) and *delegates* work to the background
 * worker swarm via `delegate`, then follows progress via `checkRuns`.
 */
export interface PlannerActions {
  listProjects(): string;
  delegate(input: DelegateInput): Promise<string>;
  checkRuns(): Promise<string>;
}

/**
 * Builds the planner actions for one session. `delegate` drives the run
 * machinery directly (create run + tasks + detached supervisor); a dispatched
 * swarm is an ordinary run, tagged with the originating `sessionId`. Sessions
 * are the only public way to kick off work.
 */
export function createPlannerActions(
  config: HermesConfig,
  sessionId: string,
  plannerRef: string,
): PlannerActions {
  const implRef =
    config.defaults.implementerModel ?? config.defaults.plannerModel ?? plannerRef;

  return {
    listProjects() {
      if (config.projects.length === 0) return "No projects are configured.";
      return config.projects.map((p) => `- ${p.name}: ${p.description}`).join("\n");
    },

    async delegate(input) {
      const problem = input.problem?.trim();
      if (!problem) throw new Error("delegate requires a non-empty problem statement");

      const selected = input.projects ?? [];
      for (const p of selected) {
        if (!config.projects.find((x) => x.name === p.name)) {
          const known = config.projects.map((x) => x.name).join(", ") || "(none)";
          throw new Error(`Unknown project "${p.name}". Configured: ${known}`);
        }
      }

      // Resolve the implementer once so pre-created tasks carry model + runtime.
      const implModel = resolveModel(config, implRef);
      const implLabel = `${implModel.name}@${implModel.version}`;

      const run = createRun({ problem, plannerModel: implRef, sessionId });

      let note: string;
      if (selected.length > 0) {
        for (const p of selected) {
          createTask({
            runId: run.id,
            projectName: p.name,
            model: implLabel,
            runtime: implModel.runtime,
            prompt: p.subtask,
          });
        }
        if (input.sharedContext?.trim()) {
          putSharedContext(run.id, input.sharedContext.trim(), "planner");
        }
        note = `${selected.length} project(s): ${selected.map((p) => p.name).join(", ")}`;
      } else {
        note = "the run's planner will select projects";
      }

      const pid = spawnSupervisor(run.id);
      setSupervisorPid(run.id, pid);

      return (
        `Dispatched run ${run.id} (${note}). ` +
        `Workers are running in the background; call check_runs to follow progress, ` +
        `or the user can inspect with \`hermes run logs ${run.id} -f\` and \`hermes run show ${run.id}\`.`
      );
    },

    async checkRuns() {
      const runs = listRunsBySession(sessionId);
      if (runs.length === 0) {
        return "No runs have been dispatched from this session yet.";
      }
      const lines: string[] = [];
      for (const r of runs) {
        const terminal = r.status === "done" || r.status === "failed";
        const live = terminal ? r.status : isAlive(r.supervisor_pid) ? "running" : "stalled";
        lines.push(`${r.id}  [${live}]  $${r.cost.toFixed(4)}  ${r.problem.slice(0, 80)}`);
        for (const t of listTasks(r.id)) {
          const summary = (t.diff_ref ?? "").trim();
          lines.push(
            `    · ${t.project_name}  ${t.status}  ${t.runtime ?? "-"}  $${t.cost.toFixed(4)}` +
              (summary ? `  ${summary.slice(0, 60)}` : ""),
          );
        }
      }
      return lines.join("\n");
    },
  };
}
