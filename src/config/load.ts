import { existsSync } from "node:fs";
import { CONFIG_PATH, expandHome } from "../paths";
import { ConfigSchema, normalizeModel, type TackConfig } from "./schema";

/**
 * Loads and validates the user's config. The config file is a `.ts` module that
 * `export default`s a config object (Bun imports it natively).
 */
export async function loadConfig(path = CONFIG_PATH): Promise<TackConfig> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`tack init\` to create one.`);
  }
  const mod = (await import(path)) as { default?: unknown; config?: unknown };
  const raw = mod.default ?? mod.config;
  if (raw === undefined) {
    throw new Error(`Config at ${path} must \`export default\` a config object.`);
  }

  const parsed = ConfigSchema.parse(raw);
  const models = parsed.models.map(normalizeModel);

  // Cross-check that every referenced aws profile is actually defined, so a typo
  // surfaces at load time rather than as a confusing auth failure later.
  const known = new Set(Object.keys(parsed.aws.profiles));
  if (parsed.aws.default && !known.has(parsed.aws.default)) {
    throw new Error(
      `aws.default "${parsed.aws.default}" is not a defined profile. Known: ${[...known].join(", ") || "(none)"}`,
    );
  }
  for (const m of models) {
    if (m.awsProfile && !known.has(m.awsProfile)) {
      throw new Error(
        `model "${m.name}@${m.version}" references aws profile "${m.awsProfile}", ` +
          `which isn't defined in aws.profiles. Known: ${[...known].join(", ") || "(none)"}`,
      );
    }
  }

  return {
    projects: parsed.projects.map((p) => ({ ...p, path: expandHome(p.path) })),
    models,
    aws: parsed.aws,
    readAllowlist: parsed.readAllowlist.map(expandHome),
    defaults: parsed.defaults,
    overrides: parsed.overrides,
  };
}
