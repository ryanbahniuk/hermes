import type { ResolvedModel } from "../models/registry";
import { TackRuntime } from "./tack";
import { ClaudeRuntime } from "./claude";
import type { AgentRuntime } from "./types";

export * from "./types";

/** Picks the runtime implementation for a resolved model. */
export function selectRuntime(model: ResolvedModel): AgentRuntime {
  switch (model.runtime) {
    case "tack":
      return new TackRuntime();
    case "claude":
      return new ClaudeRuntime();
  }
}
