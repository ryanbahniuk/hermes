import { createHash, createHmac } from "node:crypto";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

/**
 * Shared transport for the Mantle gateway (`bedrock-mantle.<region>.api.aws`) —
 * the OpenAI/Anthropic-compatible endpoint that sits alongside native Bedrock.
 * Both discovery (listing the catalog) and verification (probing a model) sign
 * their requests here with SigV4 for the `bedrock-mantle` service.
 */

const MANTLE_SERVICE = "bedrock-mantle";

export const mantleBaseUrl = (region: string): string => `https://bedrock-mantle.${region}.api.aws`;

type SourceData = string | ArrayBuffer | ArrayBufferView;

/** Coerces SigV4's SourceData into something Node's crypto accepts. */
function toBinary(data: SourceData): string | Uint8Array {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Minimal `sha256`/HMAC-SHA256 constructor for SignatureV4, backed by Node's
 * crypto. With a secret it does HMAC (SigV4 signing-key derivation); without one
 * a plain digest (canonical-request / payload hash).
 */
class Sha256Hasher {
  private hash: import("node:crypto").Hash | import("node:crypto").Hmac;
  constructor(secret?: SourceData) {
    this.hash =
      secret === undefined ? createHash("sha256") : createHmac("sha256", toBinary(secret));
  }
  update(data: SourceData): void {
    this.hash.update(toBinary(data));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }
}

export interface MantleRequest {
  method: "GET" | "POST";
  /** Path under the base url, e.g. `/v1/models` or `/openai/v1/responses`. */
  path: string;
  /** Extra headers beyond host/content-type (e.g. `anthropic-version`). */
  headers?: Record<string, string>;
  /** JSON body for POSTs. */
  body?: string;
  /** Aborts the underlying fetch (e.g. a verification timeout). */
  signal?: AbortSignal;
}

/** SigV4-signs a Mantle request and executes it, returning the raw `Response`. */
export async function mantleFetch(
  region: string,
  credentials: AwsCredentialIdentityProvider,
  request: MantleRequest,
): Promise<Response> {
  const url = new URL(`${mantleBaseUrl(region)}${request.path}`);
  const headers: Record<string, string> = { host: url.hostname, ...request.headers };
  if (request.body !== undefined) headers["content-type"] ??= "application/json";

  const signer = new SignatureV4({
    service: MANTLE_SERVICE,
    region,
    credentials,
    sha256: Sha256Hasher,
  });

  const signed = await signer.sign(
    new HttpRequest({
      method: request.method,
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      headers,
      body: request.body,
    }),
  );

  return fetch(url, {
    method: request.method,
    headers: signed.headers,
    body: request.body,
    signal: request.signal,
  });
}

/** The transport label + endpoint a Mantle model is invoked through. */
export function mantleRoute(modelId: string, region: string): { source: string; endpoint: string } {
  const base = mantleBaseUrl(region);
  const { api } = mantleApi(modelId);
  if (api === "anthropic") {
    return { source: "mantle anthropic messages", endpoint: `${base}/anthropic/v1/messages` };
  }
  if (api === "responses") {
    return { source: "mantle openai responses", endpoint: `${base}/openai/v1/responses` };
  }
  return { source: "mantle openai chat", endpoint: `${base}/openai/v1/chat/completions` };
}

/** Lists the Mantle gateway catalog via a SigV4-signed GET to `/v1/models`. */
export async function listMantleModelIds(
  region: string,
  credentials: AwsCredentialIdentityProvider,
): Promise<string[]> {
  const res = await mantleFetch(region, credentials, { method: "GET", path: "/v1/models" });
  if (!res.ok) {
    throw new Error(`GET /v1/models -> HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
}

/** OpenAI-family models known to require the Responses API rather than Chat. */
const RESPONSES_MODELS = new Set(["openai.gpt-5.6-terra", "openai.gpt-5.6-sol", "openai.gpt-5.6-luna"]);

export type MantleApi = "anthropic" | "responses" | "chat";

/** Picks the Mantle API dialect for a model id (mirrors the research validator). */
export function mantleApi(modelId: string): { api: MantleApi } {
  if (modelId.startsWith("anthropic.")) return { api: "anthropic" };
  if (RESPONSES_MODELS.has(modelId)) return { api: "responses" };
  return { api: "chat" };
}
