import type { TackConfigInput } from "./schema";

/**
 * Identity helper that gives a user's `tack.config.ts` full type-checking and
 * autocomplete. Runtime validation still happens in the loader.
 *
 *   import { defineConfig } from "tack";
 *   export default defineConfig({ projects: [...], models: [...] });
 */
export function defineConfig(config: TackConfigInput): TackConfigInput {
  return config;
}
