import { z } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createChatModel } from "../models/chat";
import type { TackConfig } from "../config/schema";
import type { ResolvedModel } from "../models/registry";
import { prompts } from "../prompts";

const PlanSchema = z.object({
  sharedContext: z
    .string()
    .describe(
      "The cross-project contract: shared decisions, interfaces, naming, and conventions every " +
        "selected project's agent must conform to. Empty string if the projects are fully independent.",
    ),
  selections: z.array(
    z.object({
      project: z.string().describe("Exact name of a project from the provided list"),
      subtask: z.string().describe("Focused, self-contained task for that project's agent"),
    }),
  ),
});

export interface Selection {
  project: string;
  subtask: string;
}

export interface PlanResult {
  sharedContext: string;
  selections: Selection[];
}

/**
 * Runs the planner: selects relevant projects and drafts a per-project subtask.
 * Uses the Bedrock Converse API directly (structured output) — no tools needed.
 */
export async function plan(
  config: TackConfig,
  plannerModel: ResolvedModel,
  problem: string,
): Promise<PlanResult> {
  if (plannerModel.target.kind !== "bedrock") {
    throw new Error(`the planner currently requires a bedrock-backed model (got ${plannerModel.target.kind})`);
  }
  if (config.projects.length === 0) return { sharedContext: "", selections: [] };

  // createChatModel binds the planner's aws profile creds + region (its account).
  const structured = createChatModel(plannerModel).withStructuredOutput(PlanSchema, {
    name: "select_projects",
  });

  const projectList = config.projects.map((p) => `- ${p.name}: ${p.description}`).join("\n");
  const result = await structured.invoke([
    new SystemMessage(prompts.runPlanner),
    new HumanMessage(`Problem:\n${problem}\n\nAvailable projects:\n${projectList}`),
  ]);

  // Keep only selections that reference a real project; de-dupe by project.
  const known = new Set(config.projects.map((p) => p.name));
  const seen = new Set<string>();
  const selections: Selection[] = [];
  for (const s of result.selections) {
    if (known.has(s.project) && !seen.has(s.project)) {
      seen.add(s.project);
      selections.push(s);
    }
  }
  return { sharedContext: result.sharedContext, selections };
}
