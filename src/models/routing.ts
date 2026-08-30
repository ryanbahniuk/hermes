import type { TackConfig, ModelRoles } from "../config/schema";

/** The roles a model can be selected for. */
export type ModelRole = "planner" | "implementer" | "summary";

const ROLE_KEY: Record<ModelRole, keyof ModelRoles> = {
  planner: "plannerModel",
  implementer: "implementerModel",
  summary: "summaryModel",
};

/**
 * The effective model reference (a `name` or `name@version`) for a role, applying
 * the configured precedence:
 *
 *   config `overrides` (hard pin)  →  [intelligent routing — not yet built]  →  config `defaults`
 *
 * Returns `undefined` when nothing is configured. Callers layer their own
 * higher-priority sources on top with `??` — an explicit `--model` flag or a
 * run's stored `planner_model` always wins over this. When routing lands, it
 * slots into the one marked spot below; nothing else needs to change.
 */
export function effectiveModelRef(
  config: TackConfig,
  role: ModelRole,
): string | undefined {
  const key = ROLE_KEY[role];
  const override = config.overrides[key];
  if (override) return override;

  // TODO(routing): intelligent per-task routing goes here, between the hard
  // override above and the static default below.

  return config.defaults[key];
}
