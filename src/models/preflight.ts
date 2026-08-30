import type { TackConfig } from "../config/schema";
import { ensureAuth, type EnsureAuthOptions, type ResolvedAwsProfile } from "./aws";
import { resolveModel } from "./registry";
import { effectiveModelRef } from "./routing";

/**
 * AWS auth preflight. Before a session (interactively) or a run (in the detached
 * supervisor) uses its models, confirm each model's aws profile is authenticated
 * and pointed at the expected account — driving `aws sso login` when interactive.
 * Models with no configured profile are skipped (they use the default provider
 * chain, preserving the pre-config behavior), so this is inert until profiles are
 * configured.
 */

/** The distinct bedrock aws profiles used by the given model refs, deduped by key. */
export function awsProfilesForRefs(
  config: TackConfig,
  refs: Array<string | undefined>,
): ResolvedAwsProfile[] {
  const seen = new Map<string, ResolvedAwsProfile>();
  for (const ref of refs) {
    if (!ref) continue;
    let model;
    try {
      model = resolveModel(config, ref);
    } catch {
      continue; // A bad ref surfaces elsewhere with a better message; don't block auth here.
    }
    if (model.target.kind === "bedrock" && model.aws) {
      seen.set(model.aws.key, model.aws);
    }
  }
  return [...seen.values()];
}

/** The model refs a session/run will actually use: planner, implementer, summary. */
export function sessionModelRefs(
  config: TackConfig,
  plannerOverride?: string,
): Array<string | undefined> {
  return [
    plannerOverride ?? effectiveModelRef(config, "planner"),
    effectiveModelRef(config, "implementer"),
    effectiveModelRef(config, "summary"),
  ];
}

/**
 * Ensures every aws profile a session/run will use is authenticated (and on the
 * expected account). `autoLogin` should be true only in interactive contexts (a
 * TTY exists to complete the browser flow); the supervisor passes it false and
 * fails with a `tack aws login` hint instead. Returns the profiles it checked.
 */
export async function ensureSessionAuth(
  config: TackConfig,
  opts: { plannerOverride?: string } & EnsureAuthOptions = {},
): Promise<ResolvedAwsProfile[]> {
  const profiles = awsProfilesForRefs(config, sessionModelRefs(config, opts.plannerOverride));
  for (const profile of profiles) {
    await ensureAuth(profile, { autoLogin: opts.autoLogin, log: opts.log });
  }
  return profiles;
}
