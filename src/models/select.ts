import { discoverModels, type DiscoverOptions, type DiscoveredModel } from "./discover";

/**
 * Bridges `hermes model discover` to `hermes model add`: given the friendly
 * `name`/`version` a config entry will carry (and optionally a provider or an
 * exact Bedrock model id), it runs discovery and resolves the invocation target
 * automatically — so a user never has to know or paste an inference-profile ARN.
 */

export interface ResolveOptions extends DiscoverOptions {
  /** Friendly config name (e.g. "claude-sonnet"); used to match the Bedrock id. */
  name: string;
  /** Friendly config version (e.g. "4.5"); used to match the Bedrock id. */
  version: string;
  /** Restrict matching to one provider (config key, e.g. "anthropic", "meta"). */
  provider?: string;
  /** Exact Bedrock foundation-model id to bind (as shown by `model discover`). */
  modelId?: string;
}

export interface ResolvedBinding {
  /** Config provider key, taken from the matched model id (e.g. "anthropic"). */
  provider: string;
  /** The Bedrock foundation-model id that was matched. */
  modelId: string;
  /** The resolved application-inference-profile ARN to write as `inferenceProfile`. */
  inferenceProfile: string;
}

/** The config provider key is the leading segment of a Bedrock model id. */
export function providerKeyFromModelId(modelId: string): string {
  return modelId.split(".", 1)[0]!.toLowerCase();
}

/** Space-padded, lowercased token stream for word-boundary-aware matching. */
function tokenStream(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/** The token sequence a name/version splits into (e.g. "4.5" -> "4 5"). */
function tokenSequence(text: string): string {
  return text.split(/[^a-z0-9]+/i).filter(Boolean).join(" ").toLowerCase();
}

/**
 * A discovered model whose id/name contains both the name and the version as
 * contiguous token sequences. Word boundaries matter — version "4.5" ("4 5")
 * matches `claude-sonnet-4-5-...` but not `claude-sonnet-4-20250514-...` (whose
 * "4" is followed by a date, and whose "5" only appears inside that date).
 */
function matchesModel(model: DiscoveredModel, name: string, version: string): boolean {
  const stream = tokenStream(`${model.modelId} ${model.modelName ?? ""}`);
  const nameSeq = tokenSequence(name);
  const versionSeq = tokenSequence(version);
  const contains = (seq: string) => seq === "" || stream.includes(` ${seq} `);
  return contains(nameSeq) && contains(versionSeq);
}

/**
 * Resolves the inference-profile target for a would-be config entry. Runs
 * discovery, narrows to native Bedrock models (by exact `modelId` when given,
 * otherwise by provider + name/version tokens), and returns the READY match.
 * Throws an actionable error when nothing matches, the match is ambiguous, or
 * the match has no usable application-inference-profile yet.
 */
export async function resolveBinding(opts: ResolveOptions): Promise<ResolvedBinding> {
  const discovered = await discoverModels({
    region: opts.region,
    profile: opts.profile,
    profilePrefix: opts.profilePrefix,
  });
  const bedrock = discovered.filter((m) => m.transport === "bedrock");

  let candidates: DiscoveredModel[];
  if (opts.modelId) {
    candidates = bedrock.filter((m) => m.modelId === opts.modelId);
    if (candidates.length === 0) {
      throw new Error(
        `No Bedrock model with id "${opts.modelId}" is visible to this identity. ` +
          `Run \`hermes model discover\` to see the available ids.`,
      );
    }
  } else {
    candidates = bedrock.filter((m) => {
      if (opts.provider && providerKeyFromModelId(m.modelId) !== opts.provider.toLowerCase()) {
        return false;
      }
      return matchesModel(m, opts.name, opts.version);
    });
    if (candidates.length === 0) {
      throw new Error(
        `No Bedrock model matched name "${opts.name}" version "${opts.version}"` +
          (opts.provider ? ` for provider "${opts.provider}"` : "") +
          `. Run \`hermes model discover\` and pass --model-id <id> (or --inference-profile <arn>).`,
      );
    }
    if (candidates.length > 1) {
      const ids = candidates.map((m) => m.modelId).sort().join(", ");
      throw new Error(
        `Ambiguous match for "${opts.name}@${opts.version}" — candidates: ${ids}. ` +
          `Re-run with --model-id <id> to pick one.`,
      );
    }
  }

  // With an exact model id there may still be several rows only if the id repeats
  // (it shouldn't after dedup); pick the READY one, else the single candidate.
  const ready = candidates.find((m) => m.status === "READY");
  const chosen = ready ?? candidates[0]!;

  if (chosen.status !== "READY") {
    if (chosen.status === "MULTIPLE_APPLICATION_PROFILES") {
      throw new Error(
        `"${chosen.modelId}" has multiple application profiles: ${chosen.candidates.join(", ")}. ` +
          `Pick one with --inference-profile <arn>.`,
      );
    }
    throw new Error(
      `"${chosen.modelId}" is not ready (${chosen.status}). ` +
        `It has no usable application-inference-profile for this identity. ` +
        `Pass --inference-profile <arn> to set one explicitly.`,
    );
  }

  return {
    provider: opts.provider?.toLowerCase() ?? providerKeyFromModelId(chosen.modelId),
    modelId: chosen.modelId,
    inferenceProfile: chosen.target,
  };
}
