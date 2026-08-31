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

const BACKENDS = ["bedrock", "anthropic"] as const;
const RUNTIMES = ["claude", "tack"] as const;
type Backend = (typeof BACKENDS)[number];
type Runtime = (typeof RUNTIMES)[number];

/** A backend and/or runtime pin, used to select one of several variants. */
export interface ModelVariantSelector {
  backend?: Backend;
  runtime?: Runtime;
}

export interface ParsedModelRef {
  name: string;
  version?: string;
  backend?: Backend;
  runtime?: Runtime;
}

function isBackend(s: string): s is Backend {
  return (BACKENDS as readonly string[]).includes(s);
}
function isRuntime(s: string): s is Runtime {
  return (RUNTIMES as readonly string[]).includes(s);
}

/**
 * Parses a model reference. The base is `name` or `name@version`; optional
 * `+<qualifier>` suffixes pin a variant when one `name@version` is registered
 * under several runtime/backend combinations. Each qualifier is a backend
 * (`bedrock` | `anthropic`) or a runtime (`claude` | `tack`), order-independent —
 * e.g. `claude-sonnet@4.5+bedrock+tack`.
 */
export function parseModelRef(ref: string): ParsedModelRef {
  const [base, ...quals] = ref.split("+");
  if (!base) throw new Error(`Invalid model reference "${ref}".`);
  const [name, version] = base.includes("@") ? base.split("@") : [base, undefined];
  if (!name) throw new Error(`Invalid model reference "${ref}".`);

  let backend: Backend | undefined;
  let runtime: Runtime | undefined;
  for (const q of quals) {
    if (isBackend(q)) {
      if (backend && backend !== q) throw new Error(`Conflicting backend qualifiers in "${ref}".`);
      backend = q;
    } else if (isRuntime(q)) {
      if (runtime && runtime !== q) throw new Error(`Conflicting runtime qualifiers in "${ref}".`);
      runtime = q;
    } else {
      throw new Error(
        `Unknown qualifier "+${q}" in "${ref}" (expected one of: ${[...BACKENDS, ...RUNTIMES].join(", ")}).`,
      );
    }
  }
  return { name, version, backend, runtime };
}

/** A fully-qualified, always-unambiguous reference to one registered variant. */
export function modelVariantRef(m: Pick<Model, "name" | "version" | "backend" | "runtime">): string {
  return `${m.name}@${m.version}+${m.backend}+${m.runtime}`;
}

/**
 * The shortest reference that still resolves to `m` unambiguously against
 * `config`: bare `name@version` when it's the sole entry, else qualified by
 * backend (and runtime too when several variants share that backend). Used when
 * persisting a resolved model back to a ref (e.g. a task's model).
 */
export function canonicalModelRef(
  config: TackConfig,
  m: Pick<Model, "name" | "version" | "backend" | "runtime">,
): string {
  const sameNameVersion = config.models.filter(
    (x) => x.name === m.name && x.version === m.version,
  );
  if (sameNameVersion.length <= 1) return `${m.name}@${m.version}`;
  const sameBackend = sameNameVersion.filter((x) => x.backend === m.backend);
  return sameBackend.length <= 1
    ? `${m.name}@${m.version}+${m.backend}`
    : `${m.name}@${m.version}+${m.backend}+${m.runtime}`;
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
 * Resolves a model reference (`"name"`, `"name@version"`, optionally with
 * `+backend`/`+runtime` qualifiers) against the registry. When a `name@version`
 * is registered as several runtime/backend variants, the reference must pin one:
 * `override` (from `--backend`/`--runtime` flags) takes precedence over the ref's
 * own qualifiers, and an under-specified reference that still matches more than
 * one variant throws with the exact refs to disambiguate.
 */
export function resolveModel(
  config: TackConfig,
  ref: string,
  override: ModelVariantSelector = {},
): ResolvedModel {
  const parsed = parseModelRef(ref);
  const backend = override.backend ?? parsed.backend;
  const runtime = override.runtime ?? parsed.runtime;

  const candidates = config.models.filter(
    (m) => m.name === parsed.name && (parsed.version ? m.version === parsed.version : true),
  );
  if (candidates.length === 0) {
    const known = config.models.map((m) => modelVariantRef(m)).join(", ") || "(none)";
    throw new Error(`Unknown model "${ref}". Configured: ${known}`);
  }

  let narrowed = candidates;
  if (backend) narrowed = narrowed.filter((m) => m.backend === backend);
  if (runtime) narrowed = narrowed.filter((m) => m.runtime === runtime);

  if (narrowed.length === 0) {
    const pins = [backend && `backend "${backend}"`, runtime && `runtime "${runtime}"`]
      .filter(Boolean)
      .join(" + ");
    const opts = candidates.map((m) => modelVariantRef(m)).join(", ");
    throw new Error(`No "${parsed.name}" entry with ${pins}. Registered: ${opts}`);
  }
  if (narrowed.length > 1) {
    const opts = narrowed.map((m) => modelVariantRef(m)).join(", ");
    throw new Error(
      `Ambiguous model "${ref}" — ${narrowed.length} variants are registered. ` +
        `Pin one by appending a qualifier (or pass --runtime/--backend): ${opts}`,
    );
  }
  return toResolved(narrowed[0]!, config);
}
