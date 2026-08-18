import { ChatBedrockConverse } from "@langchain/aws";
import type { ResolvedModel } from "./registry";

export function defaultRegion(): string {
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
}

/**
 * Builds a LangChain chat model for the `hermes` runtime via the Bedrock Converse
 * API. Credentials come from the default AWS provider chain (SSO profiles, env, …).
 */
export function createChatModel(model: ResolvedModel) {
  if (model.target.kind !== "bedrock") {
    throw new Error(
      `the hermes runtime requires a bedrock target (model "${model.name}" resolved to "${model.target.kind}")`,
    );
  }
  return new ChatBedrockConverse({
    model: model.target.inferenceProfile,
    region: defaultRegion(),
  });
}
