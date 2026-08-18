import type { ResolvedModel } from "../models/registry";
import { HermesRuntime } from "./hermes";
import { ClaudeRuntime } from "./claude";
import type { AgentRuntime } from "./types";

export * from "./types";

/** Picks the runtime implementation for a resolved model. */
export function selectRuntime(model: ResolvedModel): AgentRuntime {
  switch (model.runtime) {
    case "hermes":
      return new HermesRuntime();
    case "claude":
      return new ClaudeRuntime();
  }
}
