import { existsSync } from "node:fs";
import { CONFIG_PATH, expandHome } from "../paths";
import { ConfigSchema, normalizeModel, type HermesConfig } from "./schema";

/**
 * Loads and validates the user's config. The config file is a `.ts` module that
 * `export default`s a config object (Bun imports it natively).
 */
export async function loadConfig(path = CONFIG_PATH): Promise<HermesConfig> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`hermes init\` to create one.`);
  }
  const mod = (await import(path)) as { default?: unknown; config?: unknown };
  const raw = mod.default ?? mod.config;
  if (raw === undefined) {
    throw new Error(`Config at ${path} must \`export default\` a config object.`);
  }

  const parsed = ConfigSchema.parse(raw);
  return {
    projects: parsed.projects.map((p) => ({ ...p, path: expandHome(p.path) })),
    models: parsed.models.map(normalizeModel),
    readAllowlist: parsed.readAllowlist.map(expandHome),
    defaults: parsed.defaults,
  };
}
