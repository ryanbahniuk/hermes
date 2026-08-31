import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  PricingClient,
  GetProductsCommand,
  type Filter,
} from "@aws-sdk/client-pricing";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type { Pricing, TackConfig } from "../config/schema";
import { TACK_HOME } from "../paths";
import { credentialsFor, regionFor } from "./aws";
import { createChatModel, defaultRegion } from "./chat";
import { resolveModel, type ResolvedModel } from "./registry";
import { effectiveModelRef } from "./routing";

/** Durable cache of resolved per-model rates, so add/refresh needn't re-query. */
export const PRICING_CACHE_PATH = join(TACK_HOME, "pricing-cache.json");

/** The AWS Price List API only serves from these regions; the price *data* for
 * any region is selected via the `regionCode` filter, not the client region. */
const PRICING_API_REGION = "us-east-1";

/** How stale a cached rate may be before a non-forced resolve re-fetches it. */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A model we want rates for. `key` is an opaque id echoed back by the matcher. */
export interface PricingTarget {
  key: string;
  name: string;
  version: string;
  provider: string;
  /** Region whose on-demand prices apply (the model's aws-profile region). */
  region: string;
  /** Foundation model id (e.g. `anthropic.claude-...`) when known — aids matching. */
  modelId?: string;
}

interface CacheEntry {
  pricing: Pricing;
  fetchedAt: string;
}

interface PricingCache {
  version: number;
  models: Record<string, CacheEntry>;
}

/** Cache key: a model's pricing is per (region, name@version), shared by variants. */
export function pricingCacheKey(
  t: Pick<PricingTarget, "region" | "provider" | "name" | "version">,
): string {
  return `${t.region}|${t.provider}|${t.name}@${t.version}`;
}

function readCache(): PricingCache {
  if (!existsSync(PRICING_CACHE_PATH)) return { version: 1, models: {} };
  try {
    const parsed = JSON.parse(readFileSync(PRICING_CACHE_PATH, "utf8")) as PricingCache;
    if (parsed && typeof parsed === "object" && parsed.models) return parsed;
  } catch {
    // A corrupt cache is non-fatal — treat it as empty and let it be rewritten.
  }
  return { version: 1, models: {} };
}

function writeCache(cache: PricingCache): void {
  mkdirSync(dirname(PRICING_CACHE_PATH), { recursive: true });
  writeFileSync(PRICING_CACHE_PATH, JSON.stringify(cache, null, 2));
}

/** A price-list product, reduced to the fields the matcher reasons over. This is
 * generic field selection (attributes + on-demand price dimensions) — not a
 * per-model parser; the summary model does the actual interpretation. */
interface TrimmedProduct {
  attributes: Record<string, string>;
  prices: Array<{ unit?: string; usd?: string; description?: string }>;
}

/** Does this product quote anything token-denominated? Used only to bound size. */
function isTokenProduct(p: TrimmedProduct): boolean {
  const hay = [
    p.attributes.usagetype,
    ...p.prices.map((d) => `${d.unit ?? ""} ${d.description ?? ""}`),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes("token");
}

function trimProduct(raw: unknown): TrimmedProduct | undefined {
  const product = (raw as { product?: { attributes?: Record<string, string> } }).product;
  const attributes = product?.attributes ?? {};
  const terms = (raw as { terms?: { OnDemand?: Record<string, unknown> } }).terms?.OnDemand;
  const prices: TrimmedProduct["prices"] = [];
  for (const term of Object.values(terms ?? {})) {
    const dims = (term as { priceDimensions?: Record<string, unknown> }).priceDimensions ?? {};
    for (const dim of Object.values(dims)) {
      const d = dim as {
        unit?: string;
        description?: string;
        pricePerUnit?: { USD?: string };
      };
      prices.push({ unit: d.unit, usd: d.pricePerUnit?.USD, description: d.description });
    }
  }
  if (prices.length === 0) return undefined;
  return { attributes, prices };
}

/**
 * Fetches the on-demand Bedrock price-list products for a region, trimmed to the
 * fields the matcher needs and filtered to token-denominated products to bound
 * the payload handed to the summary model.
 */
export async function fetchBedrockPriceProducts(
  region: string,
  credentials: AwsCredentialIdentityProvider,
): Promise<TrimmedProduct[]> {
  const client = new PricingClient({ region: PRICING_API_REGION, credentials });
  const filters: Filter[] = [{ Type: "TERM_MATCH", Field: "regionCode", Value: region }];

  const products: TrimmedProduct[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new GetProductsCommand({ ServiceCode: "AmazonBedrock", Filters: filters, NextToken: nextToken }),
    );
    for (const item of res.PriceList ?? []) {
      let parsed: unknown;
      try {
        parsed = typeof item === "string" ? JSON.parse(item) : item;
      } catch {
        continue;
      }
      const trimmed = trimProduct(parsed);
      if (trimmed && isTokenProduct(trimmed)) products.push(trimmed);
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return products;
}

const MatchSchema = z.object({
  matches: z.array(
    z.object({
      key: z.string().describe("The exact `key` of the target model these rates are for."),
      matchedModel: z
        .string()
        .describe("The price-list model name/usagetype you matched, or empty string if no confident match."),
      inputPer1M: z.number().nullable().describe("USD per 1,000,000 input tokens, or null if not found."),
      outputPer1M: z.number().nullable().describe("USD per 1,000,000 output tokens, or null if not found."),
      cacheReadPer1M: z
        .number()
        .nullable()
        .describe("USD per 1,000,000 cache-read input tokens, or null if not found."),
      cacheWritePer1M: z
        .number()
        .nullable()
        .describe("USD per 1,000,000 cache-write input tokens, or null if not found."),
    }),
  ),
});

const MATCH_SYSTEM = [
  "You map AWS Bedrock on-demand price-list products to a caller's registered models.",
  "You are given (1) a list of target models, each with a `key`, provider, name, version, and",
  "optional Bedrock modelId, and (2) trimmed Bedrock price-list products for one AWS region.",
  "For each target, find the price-list product(s) for the SAME model family AND version, then",
  "report the token rates as USD per 1,000,000 tokens.",
  "Price units vary — 'per 1K tokens', 'per 1M tokens', or 'per token'. Normalize every rate to",
  "USD per 1,000,000 tokens (e.g. $0.003 per 1K tokens => 3.0 per 1M).",
  "Distinguish input, output, cache-read, and cache-write token prices from each product's",
  "usagetype/description. Use null for any rate you cannot find.",
  "Only match when confident about both the model family and the version; if unsure, return the",
  "target with all rates null and matchedModel empty. Do not guess or fabricate prices.",
  "Return exactly one entry per target key.",
].join("\n");

function pricingFromMatch(m: {
  inputPer1M: number | null;
  outputPer1M: number | null;
  cacheReadPer1M: number | null;
  cacheWritePer1M: number | null;
}): Pricing | undefined {
  const pricing: Pricing = {};
  if (m.inputPer1M != null && m.inputPer1M >= 0) pricing.inputPer1M = m.inputPer1M;
  if (m.outputPer1M != null && m.outputPer1M >= 0) pricing.outputPer1M = m.outputPer1M;
  if (m.cacheReadPer1M != null && m.cacheReadPer1M >= 0) pricing.cacheReadPer1M = m.cacheReadPer1M;
  if (m.cacheWritePer1M != null && m.cacheWritePer1M >= 0) pricing.cacheWritePer1M = m.cacheWritePer1M;
  return Object.keys(pricing).length > 0 ? pricing : undefined;
}

/**
 * Asks the summary model to match `targets` (all in one region) against the
 * region's price-list `products`, returning per-key rates. No deterministic
 * parsing — the model reads the raw-ish products and normalizes units itself.
 */
export async function matchPricingWithModel(
  summaryModel: ResolvedModel,
  region: string,
  products: TrimmedProduct[],
  targets: PricingTarget[],
): Promise<Map<string, Pricing>> {
  const out = new Map<string, Pricing>();
  if (targets.length === 0 || products.length === 0) return out;

  const structured = createChatModel(summaryModel).withStructuredOutput(MatchSchema, {
    name: "match_pricing",
  });
  const targetList = targets.map((t) => ({
    key: t.key,
    provider: t.provider,
    name: t.name,
    version: t.version,
    modelId: t.modelId,
  }));

  const result = await structured.invoke([
    new SystemMessage(MATCH_SYSTEM),
    new HumanMessage(
      `AWS region: ${region}\n\n` +
        `Target models (JSON):\n${JSON.stringify(targetList, null, 2)}\n\n` +
        `Bedrock price-list products (JSON):\n${JSON.stringify(products)}`,
    ),
  ]);

  const byKey = new Set(targets.map((t) => t.key));
  for (const m of result.matches) {
    if (!byKey.has(m.key)) continue;
    const pricing = pricingFromMatch(m);
    if (pricing) out.set(m.key, pricing);
  }
  return out;
}

/** Resolves the configured summary model, or throws with an actionable message. */
export function resolveSummaryModel(config: TackConfig): ResolvedModel {
  const ref = effectiveModelRef(config, "summary");
  if (!ref) {
    throw new Error(
      "Auto-pricing needs `defaults.summaryModel` in your config (a bedrock-backed model). " +
        "Set one with `tack model set-default summary <name>`.",
    );
  }
  const model = resolveModel(config, ref);
  if (model.target.kind !== "bedrock") {
    throw new Error(`defaults.summaryModel ("${ref}") must be a bedrock-backed model (got ${model.target.kind}).`);
  }
  return model;
}

export interface ResolvePricingOptions {
  /** Ignore any cached rate and re-fetch/re-match (what `price refresh` uses). */
  force?: boolean;
  /** Max cache age for a non-forced resolve (defaults to 7 days). */
  maxAgeMs?: number;
  /** Progress log (stderr). */
  log?: (line: string) => void;
}

/**
 * Resolves per-model rates for `targets`, drawing from the cache when fresh and
 * otherwise fetching the region's Bedrock price list and matching it with the
 * summary model. Updates the cache. Returns a map keyed by each target's `key`;
 * a target with no confident match is simply absent from the map.
 */
export async function resolvePricing(
  config: TackConfig,
  targets: PricingTarget[],
  opts: ResolvePricingOptions = {},
): Promise<Map<string, Pricing>> {
  const results = new Map<string, Pricing>();
  if (targets.length === 0) return results;

  const cache = readCache();
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = Date.now();

  const toFetch: PricingTarget[] = [];
  for (const t of targets) {
    const cached = cache.models[pricingCacheKey(t)];
    const fresh =
      !opts.force && cached && now - new Date(cached.fetchedAt).getTime() < maxAge;
    if (fresh) results.set(t.key, cached!.pricing);
    else toFetch.push(t);
  }
  if (toFetch.length === 0) return results;

  const summaryModel = resolveSummaryModel(config);
  const credentials = credentialsFor(summaryModel.aws);

  // The price list is per region; fetch each region once and match all its
  // targets in a single summary-model call.
  const byRegion = new Map<string, PricingTarget[]>();
  for (const t of toFetch) {
    const list = byRegion.get(t.region) ?? [];
    list.push(t);
    byRegion.set(t.region, list);
  }

  const stamp = new Date(now).toISOString();
  for (const [region, group] of byRegion) {
    opts.log?.(`fetching Bedrock price list for ${region}…`);
    const products = await fetchBedrockPriceProducts(region, credentials);
    opts.log?.(`matching ${group.length} model(s) against ${products.length} price products via summary model…`);
    const matched = await matchPricingWithModel(summaryModel, region, products, group);
    for (const t of group) {
      const pricing = matched.get(t.key);
      if (!pricing) continue;
      results.set(t.key, pricing);
      cache.models[pricingCacheKey(t)] = { pricing, fetchedAt: stamp };
    }
  }

  writeCache(cache);
  return results;
}

/** Region a bedrock model's on-demand prices should be read from. */
export function pricingRegionFor(model: ResolvedModel): string {
  return model.backend === "bedrock" ? regionFor(model.aws) : defaultRegion();
}
