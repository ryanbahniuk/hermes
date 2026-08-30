import {
  query,
  type HookInput,
  type HookJSONOutput,
  type ModelUsage,
  type PermissionResult,
  type PreToolUseHookInput,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { assertReadable, assertWritable, type Scoping } from "../tools/ops";
import { defaultRegion } from "../models/chat";
import type { ResolvedModel } from "../models/registry";
import { createClaudeCoordinationServer } from "../tools/coordination";
import type { AgentEvent, AgentRuntime, AgentTask } from "./types";

// Tools we don't want a background implementation agent reaching for.
const DISALLOWED_TOOLS = ["WebSearch", "WebFetch", "Task"];

export const READ_PATH_FIELDS: Record<string, string[]> = {
  Read: ["file_path"],
  Grep: ["path"],
  Glob: ["path"],
  LS: ["path"],
};
const WRITE_PATH_FIELDS: Record<string, string[]> = {
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
};

/** Returns a deny reason if a tool's paths escape scope, else null (Bash etc. trusted). */
function scopeViolation(scoping: Scoping, toolName: string, toolInput: unknown): string | null {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  try {
    for (const field of WRITE_PATH_FIELDS[toolName] ?? []) {
      const p = input[field];
      if (typeof p === "string") assertWritable(scoping, p);
    }
    for (const field of READ_PATH_FIELDS[toolName] ?? []) {
      const p = input[field];
      if (typeof p === "string") assertReadable(scoping, p);
    }
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

/** Environment for a Claude Agent SDK query: Bedrock vs. first-party Anthropic API. */
export function bedrockEnvForModel(model: ResolvedModel): Record<string, string> {
  const base = process.env as Record<string, string>;
  if (model.target.kind === "bedrock") {
    // The SDK subprocess resolves creds/region from the environment, so pin both to
    // the model's configured aws profile — this is what lets different models reach
    // different accounts. Env vars win over an ambient AWS_PROFILE the user exported.
    const env: Record<string, string> = {
      ...base,
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: model.aws?.region ?? base.AWS_REGION ?? base.AWS_DEFAULT_REGION ?? defaultRegion(),
    };
    if (model.aws?.profile) {
      env.AWS_PROFILE = model.aws.profile;
      // Static env creds outrank AWS_PROFILE in the SDK chain, which would defeat
      // per-model account pinning — drop them so the profile is authoritative.
      delete env.AWS_ACCESS_KEY_ID;
      delete env.AWS_SECRET_ACCESS_KEY;
      delete env.AWS_SESSION_TOKEN;
    }
    return env;
  }
  // first-party Anthropic API backend
  if (!base.ANTHROPIC_API_KEY) {
    throw new Error(`backend "anthropic" requires ANTHROPIC_API_KEY in the environment`);
  }
  const env = { ...base };
  delete env.CLAUDE_CODE_USE_BEDROCK;
  return env;
}

/** The SDK model id: Bedrock inference profile or Anthropic API model id. */
export function modelIdForModel(model: ResolvedModel): string {
  return model.target.kind === "bedrock" ? model.target.inferenceProfile : model.target.apiModelId;
}

function bedrockEnv(task: AgentTask): Record<string, string> {
  return bedrockEnvForModel(task.model);
}

function modelId(task: AgentTask): string {
  return modelIdForModel(task.model);
}

function systemAppend(task: AgentTask): string {
  const allow = task.scoping.readAllowlist.join(", ") || "(none)";
  const lines = [
    "",
    "You are running as a Hermes implementation agent in an isolated git worktree.",
    `Worktree (your working directory): ${task.scoping.worktree}`,
    `Additional read-only directories: ${allow}`,
    "Write and edit files only inside the worktree. Finish with a concise summary of your changes.",
  ];
  if (task.sharedContext.trim()) {
    lines.push(
      "",
      "Shared coordination context (the cross-project contract — conform to it):",
      task.sharedContext,
      "",
      "Use the mcp__hermes__read_shared_context tool to re-read it. If you believe the contract",
      "is wrong, call mcp__hermes__propose_amendment (sparingly); otherwise conform.",
    );
  }
  return lines.join("\n");
}

/** The `claude` runtime: wraps the Claude Agent SDK, on Bedrock or the Anthropic API. */
export class ClaudeRuntime implements AgentRuntime {
  readonly kind = "claude" as const;

  async *run(task: AgentTask): AsyncIterable<AgentEvent> {
    let env: Record<string, string>;
    let model: string;
    try {
      env = bedrockEnv(task);
      model = modelId(task);
    } catch (err) {
      yield { type: "error", message: (err as Error).message };
      return;
    }

    const { scoping } = task;
    // canUseTool auto-allows (no human prompts); the PreToolUse hook enforces scope.
    const canUseTool = async (): Promise<PermissionResult> => ({ behavior: "allow" });
    const preToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
      const i = input as PreToolUseHookInput;
      const reason = scopeViolation(scoping, i.tool_name, i.tool_input);
      if (reason) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        };
      }
      return {};
    };

    let summary = "";
    let sessionEmitted = false;

    try {
      const q = query({
        prompt: task.prompt,
        options: {
          cwd: scoping.worktree,
          model,
          env,
          executable: "bun",
          settingSources: [],
          permissionMode: "default",
          disallowedTools: DISALLOWED_TOOLS,
          canUseTool,
          hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
          mcpServers: { hermes: createClaudeCoordinationServer(task.coordination) },
          systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend(task) },
        },
      });

      for await (const msg of q) {
        if (!sessionEmitted && "session_id" in msg && msg.session_id) {
          sessionEmitted = true;
          yield { type: "session", ref: msg.session_id };
        }
        if (msg.type === "assistant") {
          yield* fromAssistant(msg);
        } else if (msg.type === "user") {
          yield* fromUser(msg);
        } else if (msg.type === "result") {
          yield* eventsFromClaudeResult(msg);
          if (msg.subtype === "success") summary = msg.result || summary;
        }
      }

      yield { type: "done", summary: summary || "(no summary)" };
    } catch (err) {
      yield { type: "error", message: (err as Error).message };
    }
  }
}

/** Usage + cost (+ abnormal-end error) events from an SDK result message. */
export function* eventsFromClaudeResult(msg: SDKResultMessage): Generator<AgentEvent> {
  // modelUsage carries the authoritative cumulative per-model totals.
  yield { type: "usage", ...sumModelUsage(msg.modelUsage) };
  yield { type: "cost", usd: msg.total_cost_usd };
  if (msg.subtype !== "success") {
    yield { type: "error", message: `agent ended abnormally: ${msg.subtype}` };
  }
}

export function sumModelUsage(modelUsage: Record<string, ModelUsage> | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const u of Object.values(modelUsage ?? {})) {
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
    cacheReadTokens += u.cacheReadInputTokens ?? 0;
    cacheWriteTokens += u.cacheCreationInputTokens ?? 0;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

export function* fromAssistant(msg: SDKAssistantMessage): Generator<AgentEvent> {
  const content = (msg.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      yield { type: "text", text: block.text };
    } else if (block.type === "tool_use") {
      yield { type: "tool_call", tool: String(block.name), input: block.input };
    }
  }
}

export function* fromUser(msg: SDKUserMessage): Generator<AgentEvent> {
  const content = (msg.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "tool_result") {
      const raw = block.content;
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      yield { type: "tool_result", tool: "tool", ok: block.is_error !== true, preview: (text ?? "").slice(0, 200) };
    }
  }
}
