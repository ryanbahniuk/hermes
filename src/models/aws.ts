import { spawnSync } from "node:child_process";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type { AwsConfig } from "../config/schema";

/** Region from the environment, or `us-east-1` — the fallback when no profile pins one. */
function envRegion(): string {
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
}

/**
 * Account/profile-aware AWS auth. A model names an `aws.profiles` entry (or falls
 * back to `aws.default`); that entry pins the shared-config profile, the region,
 * and the expected account id. Every Bedrock call for that model then resolves
 * credentials and region through the entry — so models in different accounts each
 * authenticate as their own identity — and `ensureAuth` confirms the resolved
 * identity is the expected account, driving `aws sso login` when the session has
 * expired (interactive contexts only).
 */

/** A profile block resolved to the concrete values callers need. */
export interface ResolvedAwsProfile {
  /** The `aws.profiles` key this was resolved from. */
  key: string;
  /** Shared-config profile name (for the SDK and `aws sso login`). */
  profile: string;
  /** Expected 12-digit account id, asserted by `ensureAuth` when set. */
  account?: string;
  /** Region the model's inference profile lives in, when pinned. */
  region?: string;
}

/**
 * Resolves the profile a model should use: its own `awsProfile` key, else the
 * config default. Returns `undefined` when neither is set (the standard provider
 * chain / `AWS_REGION` are used, preserving the pre-config behavior). Throws when
 * a named key isn't defined — the loader already cross-checks, so this is defense
 * in depth for callers that resolve ad-hoc keys.
 */
export function resolveAwsProfile(
  aws: AwsConfig,
  key: string | undefined,
): ResolvedAwsProfile | undefined {
  const name = key ?? aws.default;
  if (!name) return undefined;
  const entry = aws.profiles[name];
  if (!entry) {
    const known = Object.keys(aws.profiles).join(", ") || "(none)";
    throw new Error(`Unknown aws profile "${name}". Configured: ${known}`);
  }
  return { key: name, profile: entry.profile, account: entry.account, region: entry.region };
}

/** Credentials for a resolved profile, or the default provider chain when unbound. */
export function credentialsFor(
  profile: ResolvedAwsProfile | undefined,
): AwsCredentialIdentityProvider {
  return defaultProvider(profile?.profile ? { profile: profile.profile } : {});
}

/** Region for a resolved profile, falling back to `AWS_REGION` / `us-east-1`. */
export function regionFor(profile: ResolvedAwsProfile | undefined): string {
  return profile?.region ?? envRegion();
}

/** The identity behind a set of credentials, as returned by STS. */
export interface CallerIdentity {
  account: string;
  arn: string;
  userId: string;
}

/**
 * Resolves the caller identity through the *JS SDK* credential path (the same one
 * the runtimes use), so this verifies exactly what Tack will authenticate with —
 * not merely what the `aws` CLI can see. Returns the identity, or throws with a
 * name we can classify (see `isAuthError`).
 */
export async function getCallerIdentity(
  profile: ResolvedAwsProfile | undefined,
): Promise<CallerIdentity> {
  const client = new STSClient({
    region: regionFor(profile),
    credentials: credentialsFor(profile),
  });
  const res = await client.send(new GetCallerIdentityCommand({}));
  return {
    account: res.Account ?? "",
    arn: res.Arn ?? "",
    userId: res.UserId ?? "",
  };
}

/** True when an error is a missing/expired-credential failure `aws sso login` can fix. */
export function isAuthError(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err);
  return (
    name === "CredentialsProviderError" ||
    name === "ExpiredToken" ||
    name === "ExpiredTokenException" ||
    name === "InvalidGrantException" ||
    name.includes("SSO") ||
    /could not load credentials|token.*expired|expired.*token|sso session/i.test(message)
  );
}

/**
 * Drives `aws sso login --profile <name>` as a foreground child so the user can
 * complete the browser flow. Requires a TTY and the `aws` CLI; throws when the CLI
 * is absent or login exits non-zero.
 */
export function ssoLogin(profile: string): void {
  const res = spawnSync("aws", ["sso", "login", "--profile", profile], {
    stdio: "inherit",
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        "The `aws` CLI is required for `aws sso login` but wasn't found on PATH. Install it (brew install awscli).",
      );
    }
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`\`aws sso login --profile ${profile}\` exited with status ${res.status}.`);
  }
}

export interface EnsureAuthOptions {
  /** Drive `aws sso login` on a credential/expiry error, then retry (interactive only). */
  autoLogin?: boolean;
  /** Progress sink for the human (defaults to stderr). */
  log?: (line: string) => void;
}

/**
 * Confirms a profile is authenticated and — when the profile pins an `account` —
 * that the resolved identity is that account. On a credential/expiry error with
 * `autoLogin`, runs `aws sso login` once and retries. Throws an actionable error
 * on a wrong account or when auth still fails. Returns the verified identity.
 *
 * A wrong account is never auto-fixable by login, so it fails immediately with the
 * expected-vs-actual account — turning a silent misroute into a clear stop.
 */
export async function ensureAuth(
  profile: ResolvedAwsProfile | undefined,
  opts: EnsureAuthOptions = {},
): Promise<CallerIdentity> {
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const label = profile ? `${profile.key} (${profile.profile})` : "default credentials";

  let identity: CallerIdentity;
  try {
    identity = await getCallerIdentity(profile);
  } catch (err) {
    if (opts.autoLogin && profile?.profile && isAuthError(err)) {
      log(`# aws: ${label} needs sign-in — running \`aws sso login --profile ${profile.profile}\`…`);
      ssoLogin(profile.profile);
      identity = await getCallerIdentity(profile);
    } else {
      throw new Error(describeAuthError(err, profile));
    }
  }

  if (profile?.account && identity.account && identity.account !== profile.account) {
    throw new Error(
      `aws profile "${profile.key}" is authenticated to account ${identity.account}, ` +
        `but the config expects ${profile.account}. ` +
        `Check the "${profile.profile}" profile in ~/.aws/config (or fix aws.profiles.${profile.key}.account).`,
    );
  }
  return identity;
}

/** Turns an STS/credential error into a one-line message with a repair hint. */
export function describeAuthError(err: unknown, profile: ResolvedAwsProfile | undefined): string {
  const message = err instanceof Error ? err.message : String(err);
  const hint = profile
    ? `Run: tack aws login ${profile.key}`
    : "Run `aws sso login` (or set AWS_PROFILE), or define an aws profile with `tack aws add`.";
  if (isAuthError(err)) {
    return `AWS credentials for ${profile ? `"${profile.key}"` : "the default chain"} are missing or expired. ${hint}`;
  }
  return `Could not verify AWS identity${profile ? ` for "${profile.key}"` : ""}: ${message}`;
}
