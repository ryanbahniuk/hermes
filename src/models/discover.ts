import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type FoundationModelSummary,
  type InferenceProfileSummary,
} from "@aws-sdk/client-bedrock";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { defaultRegion } from "./chat";
import { listMantleModelIds, mantleRoute } from "./mantle";

/**
 * Self-discovery of the Bedrock chat models the authenticated AWS identity can
 * reach, and the invocation target (an inference-profile id/ARN) to drop into a
 * model's `inferenceProfile` in the Tack config.
 *
 * Two catalogs are merged transparently:
 *   - Native Bedrock (`find_bedrock_ids.py`): list foundation models, list
 *     SYSTEM_DEFINED + APPLICATION inference profiles, then resolve each
 *     foundation model to the application-inference-profile ARN that authorizes
 *     it. Invoked via the Bedrock Converse API / Claude SDK.
 *   - Mantle: the OpenAI/Anthropic-compatible gateway at
 *     `bedrock-mantle.<region>.api.aws`. Listing it only proves catalog
 *     visibility, not authorization, so those entries are DISCOVERED_NOT_VALIDATED.
 *
 * When a model appears in both, the native route wins if it's usable (a READY or
 * ambiguous application profile); otherwise the Mantle route is surfaced instead
 * of an unconfigured native catalog entry. Mantle failures are non-fatal — native
 * discovery still returns.
 */

/** Why a model can (or can't) be invoked, in rough priority order. */
export type DiscoveryStatus =
  | "READY" // exactly one active application profile — `target` is its ARN
  | "MULTIPLE_APPLICATION_PROFILES" // pick one of `candidates`
  | "DISCOVERED_NOT_VALIDATED" // Mantle: visible in the gateway, not confirmed invokable
  | "APPLICATION_PROFILE_NOT_ACTIVE" // a profile exists but isn't ACTIVE
  | "NO_APPLICATION_PROFILE"; // visible in the catalog, but no project profile

/** How a discovered model is reached. */
export type Transport = "bedrock" | "mantle";

export interface DiscoveredModel {
  provider: string;
  modelId: string;
  modelName?: string;
  transport: Transport;
  /** Best invocation target: an inference-profile id/ARN (bedrock) or the model id (mantle). */
  target: string;
  status: DiscoveryStatus;
  /** Candidate application-profile ARNs when the choice is ambiguous. */
  candidates: string[];
  /** Where `target` came from (an app/system profile, the raw id, or a Mantle route). */
  source: string;
  /** Mantle HTTP endpoint for this model (mantle transport only). */
  endpoint?: string;
  /** Result of actually invoking the model — present only after `tack model discover --verify`. */
  verification?: Verification;
}

/** Outcome of probing a model with a minimal real invocation. */
export interface Verification {
  ok: boolean;
  /** Short human-readable detail: a success note or the failure reason. */
  detail: string;
}

export interface DiscoverOptions {
  region?: string;
  /** AWS named profile; defaults to the standard provider chain (AWS_PROFILE, …). */
  profile?: string;
  /** Only select application profiles whose name/id contains this substring. */
  profilePrefix?: string;
}

/**
 * Credentials from the standard node provider chain (env, shared config, SSO, …),
 * pinned to a named profile when one is given. Shared by the Bedrock client and
 * the Mantle SigV4 signer so both authenticate as the same identity.
 */
export function resolveCredentials(opts: DiscoverOptions): AwsCredentialIdentityProvider {
  return defaultProvider(opts.profile ? { profile: opts.profile } : {});
}

function bedrockClient(opts: DiscoverOptions, credentials: AwsCredentialIdentityProvider): BedrockClient {
  return new BedrockClient({ region: opts.region ?? defaultRegion(), credentials });
}

async function listFoundationModels(client: BedrockClient): Promise<FoundationModelSummary[]> {
  // ListFoundationModels is not paginated (returns the full catalog in one call).
  const res = await client.send(new ListFoundationModelsCommand({}));
  return res.modelSummaries ?? [];
}

async function listInferenceProfiles(
  client: BedrockClient,
  typeEquals: "SYSTEM_DEFINED" | "APPLICATION",
): Promise<InferenceProfileSummary[]> {
  const out: InferenceProfileSummary[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListInferenceProfilesCommand({ typeEquals, nextToken }),
    );
    out.push(...(res.inferenceProfileSummaries ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

/** Pulls the trailing identifier out of a `foundation-model`/`inference-profile` ARN. */
function identifierFromArn(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const markers = [
    ":foundation-model/",
    "/foundation-model/",
    ":inference-profile/",
    "/inference-profile/",
    ":application-inference-profile/",
    "/application-inference-profile/",
  ];
  for (const marker of markers) {
    const idx = value.lastIndexOf(marker);
    if (idx !== -1) return value.slice(idx + marker.length);
  }
  if (value.startsWith("arn:")) {
    const slash = value.lastIndexOf("/");
    return slash === -1 ? value : value.slice(slash + 1);
  }
  return value;
}

/** Every way this profile might be referenced (its id, ARN, and their tails). */
function profileKeys(profile: InferenceProfileSummary): Set<string> {
  const keys = new Set<string>();
  for (const value of [profile.inferenceProfileId, profile.inferenceProfileArn]) {
    if (!value) continue;
    keys.add(value);
    const id = identifierFromArn(value);
    if (id) keys.add(id);
  }
  return keys;
}

/** The model identifiers a profile wraps (may themselves be other profiles). */
function profileModelReferences(profile: InferenceProfileSummary): Set<string> {
  const refs = new Set<string>();
  for (const model of profile.models ?? []) {
    const ref = identifierFromArn(model.modelArn);
    if (ref) refs.add(ref);
  }
  return refs;
}

/**
 * Walks a profile's references down to the concrete foundation model(s) it
 * ultimately targets — application profiles often wrap a system profile, which
 * in turn wraps the foundation model.
 */
function resolveFoundationModels(
  reference: string,
  rawProfileReferences: Map<string, Set<string>>,
  foundationModelIds: Set<string>,
  seen: Set<string> = new Set(),
): Set<string> {
  if (seen.has(reference)) return new Set();
  seen.add(reference);

  if (foundationModelIds.has(reference)) return new Set([reference]);

  const children = rawProfileReferences.get(reference);
  if (!children || children.size === 0) return new Set();

  const resolved = new Set<string>();
  for (const child of children) {
    for (const model of resolveFoundationModels(
      child,
      rawProfileReferences,
      foundationModelIds,
      new Set(seen),
    )) {
      resolved.add(model);
    }
  }
  return resolved;
}

interface ProfileRecord {
  arn?: string;
  id?: string;
  name?: string;
  status?: string;
}

interface ProfileIndexes {
  systemProfilesByModel: Map<string, Set<string>>;
  applicationProfilesByModel: Map<string, ProfileRecord[]>;
}

function buildProfileIndexes(
  systemProfiles: InferenceProfileSummary[],
  applicationProfiles: InferenceProfileSummary[],
  foundationModelIds: Set<string>,
): ProfileIndexes {
  const rawProfileReferences = new Map<string, Set<string>>();
  for (const profile of [...systemProfiles, ...applicationProfiles]) {
    const references = profileModelReferences(profile);
    for (const key of profileKeys(profile)) {
      const set = rawProfileReferences.get(key) ?? new Set<string>();
      for (const ref of references) set.add(ref);
      rawProfileReferences.set(key, set);
    }
  }

  const systemProfilesByModel = new Map<string, Set<string>>();
  for (const profile of systemProfiles) {
    const models = new Set<string>();
    for (const ref of profileModelReferences(profile)) {
      for (const m of resolveFoundationModels(ref, rawProfileReferences, foundationModelIds)) {
        models.add(m);
      }
    }
    const profileId = profile.inferenceProfileId;
    if (!profileId) continue;
    for (const modelId of models) {
      const set = systemProfilesByModel.get(modelId) ?? new Set<string>();
      set.add(profileId);
      systemProfilesByModel.set(modelId, set);
    }
  }

  const applicationProfilesByModel = new Map<string, ProfileRecord[]>();
  for (const profile of applicationProfiles) {
    const models = new Set<string>();
    for (const ref of profileModelReferences(profile)) {
      for (const m of resolveFoundationModels(ref, rawProfileReferences, foundationModelIds)) {
        models.add(m);
      }
    }
    const record: ProfileRecord = {
      arn: profile.inferenceProfileArn,
      id: profile.inferenceProfileId,
      name: profile.inferenceProfileName,
      status: profile.status,
    };
    for (const modelId of models) {
      const list = applicationProfilesByModel.get(modelId) ?? [];
      list.push(record);
      applicationProfilesByModel.set(modelId, list);
    }
  }

  return { systemProfilesByModel, applicationProfilesByModel };
}

interface ProfileChoice {
  target: string;
  status: DiscoveryStatus;
  candidates: string[];
}

function chooseApplicationProfile(
  profiles: ProfileRecord[],
  profilePrefix?: string,
): ProfileChoice {
  const unique = new Map<string, ProfileRecord>();
  for (const profile of profiles) {
    if (profile.arn) unique.set(profile.arn, profile);
  }
  let candidates = [...unique.values()];

  if (profilePrefix) {
    candidates = candidates.filter(
      (p) =>
        (p.name ?? "").includes(profilePrefix) || (p.id ?? "").includes(profilePrefix),
    );
    if (candidates.length === 0) {
      return { target: "NO_PROFILE_MATCHING_PREFIX", status: "NO_APPLICATION_PROFILE", candidates: [] };
    }
  }

  const active = candidates.filter((p) => p.status == null || p.status === "ACTIVE");

  if (active.length === 1) {
    return { target: active[0]!.arn!, status: "READY", candidates: [active[0]!.arn!] };
  }
  if (active.length > 1) {
    return {
      target: "CHOOSE_APPLICATION_PROFILE",
      status: "MULTIPLE_APPLICATION_PROFILES",
      candidates: active.map((p) => p.arn!).sort(),
    };
  }
  if (candidates.length > 0) {
    return {
      target: "APPLICATION_PROFILE_NOT_ACTIVE",
      status: "APPLICATION_PROFILE_NOT_ACTIVE",
      candidates: candidates.map((p) => p.arn!).filter(Boolean).sort(),
    };
  }
  return { target: "NEEDS_APPLICATION_PROFILE", status: "NO_APPLICATION_PROFILE", candidates: [] };
}

/** Drops non-conversational models (embeddings, rerank, transcription, …). */
function isNonChatModel(modelId: string): boolean {
  const lowered = modelId.toLowerCase();
  const excluded = ["rerank", "embedding", "embed-", ".embed", "moderation", "transcribe", "text-to-speech", "speech-to-text"];
  return excluded.some((term) => lowered.includes(term));
}

/** A comparable version tuple, ignoring dates (20251001) and param counts (70b). */
function versionKey(text: string): number[] {
  const versions: number[][] = [];
  const pattern = /(?<![A-Za-z0-9])(?:v)?(\d+(?:[.-]\d+){0,2})(?![A-Za-z0-9])/g;
  for (const match of text.matchAll(pattern)) {
    const value = match[1]!;
    const parts = value.split(/[.-]/).map((x) => parseInt(x, 10));
    if (value.length === 8 && value.startsWith("20")) continue; // date
    if (parts.some((p) => p >= 100)) continue; // param count
    versions.push(parts);
  }
  return versions.sort(compareTuples).at(-1) ?? [0];
}

/** Lexicographic tuple compare, padding the shorter with zeros. */
function compareTuples(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Sort key: newest first by version, then embedded release date, then id. */
function compareByRecency(a: DiscoveredModel, b: DiscoveredModel): number {
  const textA = `${a.modelId} ${a.modelName ?? ""}`;
  const textB = `${b.modelId} ${b.modelName ?? ""}`;
  const v = compareTuples(versionKey(textB), versionKey(textA));
  if (v !== 0) return v;
  const dateA = maxReleaseDate(textA);
  const dateB = maxReleaseDate(textB);
  if (dateB !== dateA) return dateB - dateA;
  return a.modelId.localeCompare(b.modelId);
}

function maxReleaseDate(text: string): number {
  const dates = [...text.matchAll(/(?<!\d)20\d{6}(?!\d)/g)].map((m) => parseInt(m[0], 10));
  return dates.length ? Math.max(...dates) : 0;
}

const PROVIDER_NAMES: Record<string, string> = {
  ai21: "AI21 Labs",
  amazon: "Amazon",
  anthropic: "Anthropic",
  cohere: "Cohere",
  deepseek: "DeepSeek",
  google: "Google",
  meta: "Meta",
  minimax: "MiniMax",
  mistral: "Mistral AI",
  moonshot: "Moonshot AI",
  moonshotai: "Moonshot AI",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  qwen: "Qwen",
  twelvelabs: "TwelveLabs",
  writer: "Writer",
  xai: "xAI",
  zai: "Z.AI",
};

function providerName(modelId: string): string {
  const key = modelId.split(".", 1)[0]!.toLowerCase();
  return PROVIDER_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Discovers the Mantle gateway catalog as `DiscoveredModel` rows. */
async function discoverMantle(
  opts: DiscoverOptions,
  credentials: AwsCredentialIdentityProvider,
): Promise<DiscoveredModel[]> {
  const region = opts.region ?? defaultRegion();
  const ids = await listMantleModelIds(region, credentials);

  const rows: DiscoveredModel[] = [];
  for (const modelId of ids) {
    if (isNonChatModel(modelId)) continue;
    const { source, endpoint } = mantleRoute(modelId, region);
    rows.push({
      provider: providerName(modelId),
      modelId,
      modelName: modelId,
      transport: "mantle",
      target: modelId,
      status: "DISCOVERED_NOT_VALIDATED",
      candidates: [],
      source,
      endpoint,
    });
  }
  return rows;
}

/**
 * Rank for choosing between duplicate rows of the same model id — lower wins.
 * A usable native route beats Mantle; Mantle beats an unconfigured native entry.
 */
function rowPriority(row: DiscoveredModel): number {
  if (row.transport === "bedrock" && row.status === "READY") return 0;
  if (row.transport === "bedrock" && row.status === "MULTIPLE_APPLICATION_PROFILES") return 1;
  if (row.transport === "mantle") return 2;
  return 3;
}

/** Collapses native + Mantle rows for the same model id to the best-ranked one. */
function deduplicate(rows: DiscoveredModel[]): DiscoveredModel[] {
  const best = new Map<string, DiscoveredModel>();
  for (const row of rows) {
    const current = best.get(row.modelId);
    if (!current || rowPriority(row) < rowPriority(current)) {
      best.set(row.modelId, row);
    }
  }
  return [...best.values()];
}

/**
 * Discovers the text-in/text-out chat models reachable by the authenticated
 * identity — native Bedrock and the Mantle gateway merged into one list — each
 * resolved to its best invocation target. Throws with a credential-repair hint
 * when the AWS profile is missing or its SSO session has expired. Mantle listing
 * is best-effort: on failure it warns to stderr and returns native results only.
 */
export async function discoverModels(opts: DiscoverOptions = {}): Promise<DiscoveredModel[]> {
  const credentials = resolveCredentials(opts);
  const client = bedrockClient(opts, credentials);

  let foundationModels: FoundationModelSummary[];
  let systemProfiles: InferenceProfileSummary[];
  let applicationProfiles: InferenceProfileSummary[];
  try {
    [foundationModels, systemProfiles, applicationProfiles] = await Promise.all([
      listFoundationModels(client),
      listInferenceProfiles(client, "SYSTEM_DEFINED"),
      listInferenceProfiles(client, "APPLICATION"),
    ]);
  } catch (err) {
    throw new Error(describeAwsError(err, opts));
  }

  const foundationModelIds = new Set(
    foundationModels.map((m) => m.modelId).filter((id): id is string => Boolean(id)),
  );

  const { systemProfilesByModel, applicationProfilesByModel } = buildProfileIndexes(
    systemProfiles,
    applicationProfiles,
    foundationModelIds,
  );

  const rows: DiscoveredModel[] = [];
  for (const model of foundationModels) {
    const modelId = model.modelId;
    if (!modelId || isNonChatModel(modelId)) continue;

    const inputs = new Set(model.inputModalities ?? []);
    const outputs = new Set(model.outputModalities ?? []);
    if (!inputs.has("TEXT") || !outputs.has("TEXT")) continue;

    const choice = chooseApplicationProfile(
      applicationProfilesByModel.get(modelId) ?? [],
      opts.profilePrefix,
    );

    const systemIds = [...(systemProfilesByModel.get(modelId) ?? [])].sort((a, b) =>
      compareTuples(versionKey(b), versionKey(a)),
    );

    // When there's a READY app profile its ARN is the invocation target; else
    // fall back to a system inference profile id (may need authorization), else
    // the raw model id.
    let target = choice.target;
    let source: string;
    if (choice.status === "READY") {
      source = "application-inference-profile";
    } else if (systemIds.length > 0) {
      target = systemIds[0]!;
      source = "system-inference-profile";
    } else {
      target = modelId;
      source = "foundation-model";
    }

    rows.push({
      provider: model.providerName ?? providerName(modelId),
      modelId,
      modelName: model.modelName,
      transport: "bedrock",
      target,
      status: choice.status,
      candidates: choice.candidates,
      source,
    });
  }

  // Fold in the Mantle gateway catalog. It's best-effort: catalog visibility
  // there doesn't prove authorization, and the endpoint can be unreachable, so a
  // failure just warns and leaves native discovery intact.
  try {
    rows.push(...(await discoverMantle(opts, credentials)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`# warning: Mantle listing skipped: ${message}\n`);
  }

  return deduplicate(rows);
}

/** Groups discovered models by provider, each list newest-first. */
export function groupByProvider(
  models: DiscoveredModel[],
): Map<string, DiscoveredModel[]> {
  const grouped = new Map<string, DiscoveredModel[]>();
  for (const model of models) {
    const list = grouped.get(model.provider) ?? [];
    list.push(model);
    grouped.set(model.provider, list);
  }
  for (const list of grouped.values()) list.sort(compareByRecency);
  return new Map([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function describeAwsError(err: unknown, opts: DiscoverOptions): string {
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err);
  const profile = opts.profile ?? process.env.AWS_PROFILE;
  const loginHint = profile
    ? `Run: aws sso login --profile ${profile}`
    : "Run `aws sso login` (or set AWS_PROFILE to your Bedrock profile).";

  if (name === "CredentialsProviderError" || /could not load credentials/i.test(message)) {
    return `No usable AWS credentials found. ${loginHint}`;
  }
  if (/token.*expired|expired.*token|sso session/i.test(message) || name.includes("SSO")) {
    return `AWS SSO session expired. ${loginHint}`;
  }
  if (name === "AccessDeniedException") {
    return `Access denied listing Bedrock models: ${message}\n(The role may lack bedrock:ListFoundationModels / bedrock:ListInferenceProfiles.)`;
  }
  return `Bedrock discovery failed: ${message}`;
}
