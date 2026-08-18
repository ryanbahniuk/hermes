import { z } from "zod";
import { ChatBedrockConverse } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { defaultRegion } from "../models/chat";
import type { ResolvedModel } from "../models/registry";

const VerdictSchema = z.object({
  decision: z.enum(["accept", "reject"]),
  reason: z.string().describe("Brief justification for the decision"),
  updatedContext: z
    .string()
    .optional()
    .describe("If accepted, the FULL revised shared context incorporating the change; otherwise omit"),
});

export interface Verdict {
  decision: "accept" | "reject";
  reason: string;
  updatedContext?: string;
}

const SYSTEM = [
  "You are the coordinator/adjudicator for Hermes, a multi-repo development harness.",
  "An implementation agent has proposed an amendment to the shared cross-project contract.",
  "Trust the existing contract by DEFAULT — reject unless the proposal is clearly justified",
  "and materially improves cross-project consistency or correctness.",
  "If you accept, return the FULL revised shared context (not just the delta).",
].join("\n");

/**
 * Adjudicates an amendment proposal with a powerful model (planner-authoritative).
 * Uses Bedrock Converse directly (structured output).
 */
export async function adjudicate(
  model: ResolvedModel,
  input: { problem: string; currentContext: string; proposal: string },
): Promise<Verdict> {
  if (model.target.kind !== "bedrock") {
    throw new Error(`the adjudicator currently requires a bedrock-backed model (got ${model.target.kind})`);
  }
  const llm = new ChatBedrockConverse({ model: model.target.inferenceProfile, region: defaultRegion() });
  const structured = llm.withStructuredOutput(VerdictSchema, { name: "adjudicate_amendment" });

  return structured.invoke([
    new SystemMessage(SYSTEM),
    new HumanMessage(
      `Problem:\n${input.problem}\n\n` +
        `Current shared context:\n${input.currentContext || "(empty)"}\n\n` +
        `Proposed amendment:\n${input.proposal}`,
    ),
  ]) as Promise<Verdict>;
}
