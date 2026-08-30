import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { defaultRegion } from "./chat";
import {
  resolveCredentials,
  type DiscoverOptions,
  type DiscoveredModel,
  type Verification,
} from "./discover";
import { mantleApi, mantleFetch } from "./mantle";

/**
 * Verification actually invokes each discovered model with a minimal request to
 * prove the authenticated AWS profile can use it — native models via the Bedrock
 * Converse API (the same path Hermes' runtimes take), Mantle models via a signed
 * POST to their gateway route. These are real, billable inference calls, so this
 * only runs when the user opts in with `hermes model discover --verify`.
 */

export interface VerifyOptions extends DiscoverOptions {
  /** Prompt sent to each model (kept tiny). */
  prompt?: string;
  /** Max output tokens per probe. */
  maxTokens?: number;
  /** Per-model timeout in milliseconds. */
  timeoutMs?: number;
  /** How many models to probe at once. */
  concurrency?: number;
  /** Called after each model resolves, for progress reporting. */
  onProgress?: (done: number, total: number, model: DiscoveredModel) => void;
}

const DEFAULT_PROMPT = "Reply with exactly: ok";
// 64, not a smaller value: the Mantle OpenAI Responses API rejects a
// `max_output_tokens` below its minimum, which would falsely fail those models.
const DEFAULT_MAX_TOKENS = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 6;

/** The concrete id/ARN to invoke: a real application-profile ARN when we have one. */
function invocationTarget(model: DiscoveredModel): string {
  return model.candidates[0] ?? model.target;
}

/** Trims an error into a single compact line. */
function shortError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name && err.name !== "Error" ? `${err.name}: ` : "";
    return `${name}${err.message}`.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  return String(err).slice(0, 200);
}

async function verifyBedrock(
  model: DiscoveredModel,
  opts: VerifyOptions,
  credentials: AwsCredentialIdentityProvider,
): Promise<Verification> {
  const region = opts.region ?? defaultRegion();
  const client = new BedrockRuntimeClient({ region, credentials });
  const modelId = invocationTarget(model);
  try {
    await client.send(
      new ConverseCommand({
        modelId,
        messages: [{ role: "user", content: [{ text: opts.prompt ?? DEFAULT_PROMPT }] }],
        inferenceConfig: { maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS },
      }),
      { abortSignal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
    );
    return { ok: true, detail: "converse ok" };
  } catch (err) {
    return { ok: false, detail: shortError(err) };
  }
}

/** Builds the Mantle verification request body for a model's API dialect. */
function mantleProbe(
  modelId: string,
  prompt: string,
  maxTokens: number,
): { path: string; body: string; headers?: Record<string, string> } {
  const { api } = mantleApi(modelId);
  if (api === "anthropic") {
    return {
      path: "/anthropic/v1/messages",
      headers: { "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    };
  }
  if (api === "responses") {
    return {
      path: "/openai/v1/responses",
      body: JSON.stringify({
        model: modelId,
        input: prompt,
        max_output_tokens: maxTokens,
        store: false,
      }),
    };
  }
  return {
    path: "/openai/v1/chat/completions",
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      stream: false,
    }),
  };
}

async function verifyMantle(
  model: DiscoveredModel,
  opts: VerifyOptions,
  credentials: AwsCredentialIdentityProvider,
): Promise<Verification> {
  const region = opts.region ?? defaultRegion();
  const { path, body, headers } = mantleProbe(
    model.modelId,
    opts.prompt ?? DEFAULT_PROMPT,
    opts.maxTokens ?? DEFAULT_MAX_TOKENS,
  );
  try {
    const res = await mantleFetch(region, credentials, {
      method: "POST",
      path,
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
    const text = (await res.text()).replace(/\s+/g, " ").trim();
    return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  } catch (err) {
    return { ok: false, detail: shortError(err) };
  }
}

function verifyOne(
  model: DiscoveredModel,
  opts: VerifyOptions,
  credentials: AwsCredentialIdentityProvider,
): Promise<Verification> {
  return model.transport === "mantle"
    ? verifyMantle(model, opts, credentials)
    : verifyBedrock(model, opts, credentials);
}

/**
 * Probes every given model with a minimal invocation and returns the same list
 * with each `verification` field filled in. Runs with bounded concurrency;
 * individual failures are captured as `{ ok: false }`, never thrown.
 */
export async function verifyModels(
  models: DiscoveredModel[],
  opts: VerifyOptions = {},
): Promise<DiscoveredModel[]> {
  const credentials = resolveCredentials(opts);
  const limit = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const results: DiscoveredModel[] = new Array(models.length);
  let done = 0;
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= models.length) return;
      const model = models[index]!;
      const verification = await verifyOne(model, opts, credentials);
      results[index] = { ...model, verification };
      done++;
      opts.onProgress?.(done, models.length, results[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, models.length) }, worker));
  return results;
}
