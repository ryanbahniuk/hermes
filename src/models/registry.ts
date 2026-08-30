import type { TackConfig, Model, Pricing } from "../config/schema";
import { resolveAwsProfile, type ResolvedAwsProfile } from "./aws";

export type ResolvedTarget =
  | { kind: "bedrock"; inferenceProfile: string }
  | { kind: "anthropic"; apiModelId: string };

export interface ResolvedModel {
  name: string;
  version: string;
  provider: string;
  runtime: "claude" | "tack";
  backend: "bedrock" | "anthropic";
  target: ResolvedTarget;
  /** The AWS identity a bedrock model authenticates through (undefined = default chain). */
  aws?: ResolvedAwsProfile;
  pricing?: Pricing;
}

function toResolved(m: Model, config: TackConfig): ResolvedModel {
  const target: ResolvedTarget =
    m.backend === "anthropic"
      ? { kind: "anthropic", apiModelId: m.apiModelId! }
      : { kind: "bedrock", inferenceProfile: m.inferenceProfile! };
  return {
    name: m.name,
    version: m.version,
    provider: m.provider,
    runtime: m.runtime,
    backend: m.backend,
    target,
    // Only a bedrock model authenticates against AWS; the anthropic backend uses an API key.
    aws: m.backend === "bedrock" ? resolveAwsProfile(config.aws, m.awsProfile) : undefined,
    pricing: m.pricing,
  };
}

/**
 * Resolves a model reference (`"name"` or `"name@version"`) against the registry.
 * `backendOverride` picks a specific backend when a model is registered twice.
 */
export function resolveModel(
  config: TackConfig,
  ref: string,
  backendOverride?: "bedrock" | "anthropic",
): ResolvedModel {
  const [name, version] = ref.includes("@") ? ref.split("@") : [ref, undefined];
  const candidates = config.models.filter(
    (m) => m.name === name && (version ? m.version === version : true),
  );
  if (candidates.length === 0) {
    const known = config.models.map((m) => `${m.name}@${m.version}`).join(", ") || "(none)";
    throw new Error(`Unknown model "${ref}". Configured: ${known}`);
  }

  let model = candidates[0]!;
  if (backendOverride) {
    const match = candidates.find((m) => m.backend === backendOverride);
    if (!match) {
      throw new Error(`No "${name}" entry with backend "${backendOverride}".`);
    }
    model = match;
  }
  return toResolved(model, config);
}
