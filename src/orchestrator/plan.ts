import { z } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createChatModel } from "../models/chat";
import type { HermesConfig } from "../config/schema";
import type { ResolvedModel } from "../models/registry";

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

const SYSTEM = [
  "You are the planner for Hermes, a multi-repo development harness.",
  "Given a problem and a list of locally available projects (name + description):",
  "1. Select ONLY the projects relevant to the problem (choose exclusively from the listed names).",
  "2. Write a focused, self-contained subtask for each selected project's agent.",
  "3. Author a shared context: the cross-project contract (agreed interfaces, naming, shapes)",
  "   that every selected agent must conform to so their independent changes stay consistent.",
  "If nothing is relevant, return an empty selection. If the work is fully independent,",
  "the shared context may be an empty string.",
].join("\n");

/**
 * Runs the planner: selects relevant projects and drafts a per-project subtask.
 * Uses the Bedrock Converse API directly (structured output) — no tools needed.
 */
export async function plan(
  config: HermesConfig,
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
    new SystemMessage(SYSTEM),
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
