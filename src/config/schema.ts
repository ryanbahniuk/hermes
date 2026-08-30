import { z } from "zod";

export const RuntimeKind = z.enum(["claude", "tack"]);
export const BackendKind = z.enum(["bedrock", "anthropic"]);

/**
 * A named AWS identity a Bedrock model authenticates through. `profile` is the
 * shared-config profile name passed to the SDK / `aws sso login`; `account` (a
 * 12-digit id) is asserted against `sts:GetCallerIdentity` so a wrong or expired
 * profile fails loudly instead of silently hitting another account; `region`
 * pins where the model's inference profile lives. A model points at one of these
 * by the key it's registered under (see `Model.awsProfile`), which lets different
 * models live in different accounts/regions.
 */
export const AwsProfileSchema = z.object({
  profile: z.string().min(1),
  account: z
    .string()
    .regex(/^\d{12}$/, "account must be a 12-digit AWS account id")
    .optional(),
  region: z.string().min(1).optional(),
});
export type AwsProfile = z.infer<typeof AwsProfileSchema>;

/** The `aws` config block: named profiles plus the fallback used when a model has none. */
export const AwsConfigSchema = z
  .object({
    profiles: z.record(z.string(), AwsProfileSchema).default({}),
    /** Key of the profile to use when a model doesn't name its own. */
    default: z.string().optional(),
  })
  .default({ profiles: {} });
export type AwsConfig = z.infer<typeof AwsConfigSchema>;

export const ProjectSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  description: z.string().min(1),
});
export type Project = z.infer<typeof ProjectSchema>;

/** Optional pricing, in USD per 1M tokens, for computing cost when the runtime
 * doesn't report one (the `tack` runtime). The `claude` runtime uses the SDK's
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
  /** Key into `aws.profiles` — the account/region/profile this model authenticates through. */
  awsProfile: z.string().optional(),
  pricing: PricingSchema.optional(),
});
export type ModelInput = z.infer<typeof ModelInputSchema>;

/** A model with defaults filled and validity rules satisfied. */
export interface Model {
  name: string;
  version: string;
  provider: string;
  runtime: "claude" | "tack";
  backend: "bedrock" | "anthropic";
  inferenceProfile?: string;
  apiModelId?: string;
  /** Key into `aws.profiles`; only meaningful for a bedrock backend. */
  awsProfile?: string;
  pricing?: Pricing;
}

/**
 * Fills defaults (runtime inferred from provider, backend -> "bedrock") and
 * enforces the runtime/backend/target rules from the architecture doc.
 * Throws with a clear message on violation.
 */
export function normalizeModel(m: ModelInput): Model {
  const runtime = m.runtime ?? (m.provider === "anthropic" ? "claude" : "tack");
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
  if (runtime === "tack" && backend !== "bedrock") {
    throw new Error(`runtime "tack" requires backend "bedrock" (${where})`);
  }
  if (m.awsProfile && backend !== "bedrock") {
    throw new Error(`"awsProfile" only applies to a bedrock backend (${where})`);
  }

  return {
    name: m.name,
    version: m.version,
    provider: m.provider,
    runtime,
    backend,
    inferenceProfile: m.inferenceProfile,
    apiModelId: m.apiModelId,
    awsProfile: m.awsProfile,
    pricing: m.pricing,
  };
}

/**
 * Per-role model selections. `defaults` is the fallback; `overrides` is a hard
 * pin that wins over (future) intelligent routing. Same shape for both.
 *   plannerModel     — the planning/adjudication model.
 *   implementerModel — the worker model (falls back to the planner).
 *   summaryModel     — a cheap/fast model for chores like auto-generating a
 *                      project description from its README.md / CLAUDE.md.
 */
export const ModelRolesSchema = z
  .object({
    plannerModel: z.string().optional(),
    implementerModel: z.string().optional(),
    summaryModel: z.string().optional(),
  })
  .default({});
export type ModelRoles = z.infer<typeof ModelRolesSchema>;

export const ConfigSchema = z.object({
  projects: z.array(ProjectSchema).default([]),
  models: z.array(ModelInputSchema).default([]),
  // Named AWS identities models authenticate through (account + region + profile).
  aws: AwsConfigSchema,
  readAllowlist: z.array(z.string()).default([]),
  defaults: ModelRolesSchema,
  // Hard pins that take precedence over intelligent routing (and defaults).
  overrides: ModelRolesSchema,
});

/** Shape accepted from a user's config file (before normalization). */
export type TackConfigInput = z.input<typeof ConfigSchema>;

/** Fully resolved config used throughout the app. */
export interface TackConfig {
  projects: Project[];
  models: Model[];
  aws: AwsConfig;
  readAllowlist: string[];
  defaults: ModelRoles;
  overrides: ModelRoles;
}
