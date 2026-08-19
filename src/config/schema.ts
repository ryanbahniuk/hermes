import { z } from "zod";

export const RuntimeKind = z.enum(["claude", "hermes"]);
export const BackendKind = z.enum(["bedrock", "anthropic"]);

export const ProjectSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  description: z.string().min(1),
});
export type Project = z.infer<typeof ProjectSchema>;

/** Optional pricing, in USD per 1M tokens, for computing cost when the runtime
 * doesn't report one (the `hermes` runtime). The `claude` runtime uses the SDK's
 * reported cost and ignores this. */
export const PricingSchema = z.object({
  inputPer1M: z.number().nonnegative().optional(),
  outputPer1M: z.number().nonnegative().optional(),
  cacheReadPer1M: z.number().nonnegative().optional(),
  cacheWritePer1M: z.number().nonnegative().optional(),
});
export type Pricing = z.infer<typeof PricingSchema>;

/** Raw model entry as written in a config file (runtime/backend optional). */
export const ModelInputSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  provider: z.string().min(1),
  runtime: RuntimeKind.optional(),
  backend: BackendKind.optional(),
  inferenceProfile: z.string().optional(),
  apiModelId: z.string().optional(),
  pricing: PricingSchema.optional(),
});
export type ModelInput = z.infer<typeof ModelInputSchema>;

/** A model with defaults filled and validity rules satisfied. */
export interface Model {
  name: string;
  version: string;
  provider: string;
  runtime: "claude" | "hermes";
  backend: "bedrock" | "anthropic";
  inferenceProfile?: string;
  apiModelId?: string;
  pricing?: Pricing;
}

/**
 * Fills defaults (runtime inferred from provider, backend -> "bedrock") and
 * enforces the runtime/backend/target rules from the architecture doc.
 * Throws with a clear message on violation.
 */
export function normalizeModel(m: ModelInput): Model {
  const runtime = m.runtime ?? (m.provider === "anthropic" ? "claude" : "hermes");
  const backend = m.backend ?? "bedrock";
  const where = `model "${m.name}@${m.version}"`;

  if (backend === "anthropic") {
    if (m.provider !== "anthropic" || runtime !== "claude") {
      throw new Error(
        `backend "anthropic" is only valid for provider "anthropic" + runtime "claude" (${where})`,
      );
    }
    if (!m.apiModelId) {
      throw new Error(`backend "anthropic" requires "apiModelId" (${where})`);
    }
  }
  if (backend === "bedrock" && !m.inferenceProfile) {
    throw new Error(`backend "bedrock" requires "inferenceProfile" (${where})`);
  }
  if (runtime === "hermes" && backend !== "bedrock") {
    throw new Error(`runtime "hermes" requires backend "bedrock" (${where})`);
  }

  return {
    name: m.name,
    version: m.version,
    provider: m.provider,
    runtime,
    backend,
    inferenceProfile: m.inferenceProfile,
    apiModelId: m.apiModelId,
    pricing: m.pricing,
  };
}

export const ConfigSchema = z.object({
  projects: z.array(ProjectSchema).default([]),
  models: z.array(ModelInputSchema).default([]),
  readAllowlist: z.array(z.string()).default([]),
  defaults: z
    .object({
      plannerModel: z.string().optional(),
      implementerModel: z.string().optional(),
      // A cheap/fast model used for lightweight chores like auto-generating a
      // project description from its README.md / CLAUDE.md.
      summaryModel: z.string().optional(),
    })
    .default({}),
});

/** Shape accepted from a user's config file (before normalization). */
export type HermesConfigInput = z.input<typeof ConfigSchema>;

/** Fully resolved config used throughout the app. */
export interface HermesConfig {
  projects: Project[];
  models: Model[];
  readAllowlist: string[];
  defaults: { plannerModel?: string; implementerModel?: string; summaryModel?: string };
}
