import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createChatModel } from "../models/chat";
import { createTackTools } from "../tools/tack-tools";
import { createTackCoordinationTools } from "../tools/coordination";
import { prBranchInstruction } from "../worktree/worktree";
import { render, templates } from "../prompts";
import { repoGuidance } from "./guidance";
import type { AgentEvent, AgentRuntime, AgentTask } from "./types";

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : ((b as { text?: string })?.text ?? "")))
      .join("");
  }
  return "";
}

function systemPrompt(task: AgentTask): string {
  return render(templates.workerTack, {
    worktree: task.scoping.worktree,
    readAllowlist: task.scoping.readAllowlist.join(", ") || "(none)",
    repoGuidance: repoGuidance(task.scoping.worktree),
    sharedContext: task.sharedContext,
    prBranch: prBranchInstruction(task.sessionId),
  });
}

/** The `tack` runtime: a LangGraph react agent over Bedrock Converse. */
export class TackRuntime implements AgentRuntime {
  readonly kind = "tack" as const;

  async *run(task: AgentTask): AsyncIterable<AgentEvent> {
    let llm;
    try {
      llm = createChatModel(task.model);
    } catch (err) {
      yield { type: "error", message: (err as Error).message };
      return;
    }

    // The LangGraph thread id is the task id — that's our resume handle.
    yield { type: "session", ref: task.taskId };

    const agent = createReactAgent({
      llm,
      tools: [...createTackTools(task.scoping), ...createTackCoordinationTools(task.coordination)],
      prompt: systemPrompt(task),
      checkpointer: new MemorySaver(),
    });

    const seen = new Set<string>();
    let lastText = "";

    try {
      const stream = await agent.stream(
        { messages: [new HumanMessage(task.prompt)] },
        {
          streamMode: "updates",
          recursionLimit: 100,
          configurable: { thread_id: task.taskId },
        },
      );

      for await (const update of stream) {
        for (const node of Object.keys(update)) {
          const messages: BaseMessage[] = (update as Record<string, { messages?: BaseMessage[] }>)[node]?.messages ?? [];
          for (const m of messages) {
            const key = (m as { id?: string }).id ?? `${node}:${contentToText(m.content)}`;
            if (seen.has(key)) continue;
            seen.add(key);

            for (const ev of eventsFor(m)) yield ev;

            if (m instanceof AIMessage && (m.tool_calls?.length ?? 0) === 0) {
              const text = contentToText(m.content).trim();
              if (text) lastText = text;
            }
          }
        }
      }

      yield { type: "done", summary: lastText || "(no summary)" };
    } catch (err) {
      yield { type: "error", message: (err as Error).message };
    }
  }
}

export function* eventsFor(m: BaseMessage): Generator<AgentEvent> {
  if (m instanceof AIMessage) {
    const usage = (
      m as {
        usage_metadata?: {
          input_tokens?: number;
          output_tokens?: number;
          input_token_details?: { cache_read?: number; cache_creation?: number };
        };
      }
    ).usage_metadata;
    if (usage) {
      yield {
        type: "usage",
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.input_token_details?.cache_read ?? 0,
        cacheWriteTokens: usage.input_token_details?.cache_creation ?? 0,
      };
    }
    const text = contentToText(m.content).trim();
    if (text) yield { type: "text", text };
    for (const tc of m.tool_calls ?? []) {
      yield { type: "tool_call", tool: tc.name, input: tc.args };
    }
  } else if (m instanceof ToolMessage) {
    const content = contentToText(m.content) || JSON.stringify(m.content);
    const ok = !/^(error|.*denied|.*failed)/i.test(content.slice(0, 80));
    yield { type: "tool_result", tool: m.name ?? "tool", ok, preview: content.slice(0, 200) };
  }
}
