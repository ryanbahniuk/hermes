import { ChatBedrockConverse } from "@langchain/aws";
import { credentialsFor, regionFor } from "./aws";
import type { ResolvedModel } from "./registry";

export function defaultRegion(): string {
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
}

/**
 * Builds a LangChain chat model for the `hermes` runtime via the Bedrock Converse
 * API. Credentials and region come from the model's configured aws profile (its
 * account/region), falling back to the default provider chain when unbound.
 */
export function createChatModel(model: ResolvedModel) {
  if (model.target.kind !== "bedrock") {
    throw new Error(
      `the hermes runtime requires a bedrock target (model "${model.name}" resolved to "${model.target.kind}")`,
    );
  }
  return new ChatBedrockConverse({
    model: model.target.inferenceProfile,
    region: regionFor(model.aws),
    credentials: credentialsFor(model.aws),
  });
}
