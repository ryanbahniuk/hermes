import type { HermesConfigInput } from "./schema";

/**
 * Identity helper that gives a user's `hermes.config.ts` full type-checking and
 * autocomplete. Runtime validation still happens in the loader.
 *
 *   import { defineConfig } from "hermes";
 *   export default defineConfig({ projects: [...], models: [...] });
 */
export function defineConfig(config: HermesConfigInput): HermesConfigInput {
  return config;
}
