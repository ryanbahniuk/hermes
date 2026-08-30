import type { ResolvedModel } from "../models/registry";
import type { Scoping } from "../tools/ops";

/** Coordination hooks a runtime exposes to the agent as tools (DB-backed by the caller). */
export interface Coordination {
  /** Current shared coordination context (the cross-project contract). */
  readSharedContext(): string;
  /** Propose an amendment; the supervisor adjudicates and returns the verdict. */
  proposeAmendment(proposal: string): Promise<string>;
}

/** A unit of work handed to a runtime: one project, one worktree, one agent. */
export interface AgentTask {
  taskId: string;
  runId: string;
  prompt: string;
  cwd: string;
  model: ResolvedModel;
  scoping: Scoping;
  sharedContext: string;
  coordination: Coordination;
}

/** Normalized events every runtime emits, so the supervisor stays runtime-agnostic. */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; tool: string; input: unknown }
  | { type: "tool_result"; tool: string; ok: boolean; preview: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  | { type: "cost"; usd: number } // cumulative running total (read latest, don't sum)
  | { type: "session"; ref: string } // runtime resume handle -> tasks.resume_ref
  | { type: "log"; message: string }
  | { type: "done"; summary: string }
  | { type: "error"; message: string };

export interface AgentRuntime {
  readonly kind: "claude" | "tack";
  run(task: AgentTask): AsyncIterable<AgentEvent>;
  // resume(taskId): AsyncIterable<AgentEvent>; // added in build step 4
}
