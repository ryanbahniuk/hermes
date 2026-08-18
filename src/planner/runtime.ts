import {
  query,
  type HookInput,
  type HookJSONOutput,
  type PermissionResult,
  type PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ResolvedModel } from "../models/registry";
import { createChatModel } from "../models/chat";
import {
  bedrockEnvForModel,
  eventsFromClaudeResult,
  fromAssistant,
  fromUser,
  modelIdForModel,
  READ_PATH_FIELDS,
} from "../runtimes/claude";
import { contentToText, eventsFor } from "../runtimes/hermes";
import { assertReadable, type Scoping } from "../tools/ops";
import type { AgentEvent } from "../runtimes/types";
import type { PlannerActions } from "./actions";
import { createClaudePlannerServer, createHermesPlannerTools } from "./tools";

/** A planner turn streams the same normalized events as an implementation agent. */
export type PlannerEvent = AgentEvent;

export interface PriorMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PlannerContext {
  model: ResolvedModel;
  systemPrompt: string;
  actions: PlannerActions;
  /** Read-only boundary spanning the configured project roots + read allowlist. */
  scoping: Scoping;
  /** claude only: the SDK session id to resume a prior conversation. */
  resumeRef?: string;
  /** hermes only: the transcript to seed conversation state on resume. */
  history?: PriorMessage[];
}

/** A multi-turn planning conversation. Unlike AgentRuntime, it accepts many turns. */
export interface PlannerRuntime {
  readonly kind: "claude" | "hermes";
  /** Send one user turn; stream events until the assistant yields the turn back. */
  send(text: string): AsyncIterable<PlannerEvent>;
}

export function selectPlannerRuntime(ctx: PlannerContext): PlannerRuntime {
  switch (ctx.model.runtime) {
    case "claude":
      return new ClaudePlannerRuntime(ctx);
    case "hermes":
      return new HermesPlannerRuntime(ctx);
  }
}

// Tools a read-only planner may use directly; anything else is denied by the hook.
const CLAUDE_READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "TodoWrite"]);
const CLAUDE_DISALLOWED = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "WebSearch", "WebFetch", "Task"];

/** The `claude` planner: Claude Agent SDK, resumed per turn, read-only + delegate. */
class ClaudePlannerRuntime implements PlannerRuntime {
  readonly kind = "claude" as const;
  private resumeRef?: string;

  constructor(private readonly ctx: PlannerContext) {
    this.resumeRef = ctx.resumeRef;
  }

  async *send(text: string): AsyncIterable<PlannerEvent> {
    const { ctx } = this;
    let env: Record<string, string>;
    let model: string;
    try {
      env = bedrockEnvForModel(ctx.model);
      model = modelIdForModel(ctx.model);
    } catch (err) {
      yield { type: "error", message: (err as Error).message };
      return;
    }

    const canUseTool = async (): Promise<PermissionResult> => ({ behavior: "allow" });
    const preToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
      const i = input as PreToolUseHookInput;
      const name = i.tool_name;
      if (name.startsWith("mcp__")) return {}; // our planner delegation tools
      if (!CLAUDE_READ_TOOLS.has(name)) {
        return deny(`The planner is read-only. Use the "delegate" tool to hand work to the worker swarm.`);
      }
      const reason = readScopeViolation(ctx.scoping, name, i.tool_input);
      return reason ? deny(reason) : {};
    };

    let summary = "";
    let sessionEmitted = false;

    try {
      const q = query({
        prompt: text,
        options: {
          cwd: ctx.scoping.worktree,
          model,
          env,
          executable: "bun",
          settingSources: [],
          permissionMode: "default",
          disallowedTools: CLAUDE_DISALLOWED,
          canUseTool,
          hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
          mcpServers: { hermes_planner: createClaudePlannerServer(ctx.actions) },
          systemPrompt: ctx.systemPrompt,
          ...(this.resumeRef ? { resume: this.resumeRef } : {}),
        },
      });

      for await (const msg of q) {
        if ("session_id" in msg && msg.session_id) {
          this.resumeRef = msg.session_id;
          if (!sessionEmitted) {
            sessionEmitted = true;
            yield { type: "session", ref: msg.session_id };
          }
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
      yield { type: "done", summary };
    } catch (err) {
      yield { type: "error", message: (err as Error).message };
    }
  }
}

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** Returns a deny reason if a read tool's path escapes the planner scope, else null. */
function readScopeViolation(scoping: Scoping, toolName: string, toolInput: unknown): string | null {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  try {
    for (const field of READ_PATH_FIELDS[toolName] ?? []) {
      const p = input[field];
      if (typeof p === "string") assertReadable(scoping, p);
    }
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

/** The `hermes` planner: a LangGraph react agent; conversation state kept in-process. */
class HermesPlannerRuntime implements PlannerRuntime {
  readonly kind = "hermes" as const;
  private messages: BaseMessage[];

  constructor(private readonly ctx: PlannerContext) {
    this.messages = (ctx.history ?? []).map((m) =>
      m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content),
    );
  }

  async *send(text: string): AsyncIterable<PlannerEvent> {
    const { ctx } = this;
    let llm;
    try {
      llm = createChatModel(ctx.model);
    } catch (err) {
      yield { type: "error", message: (err as Error).message };
      return;
    }

    const agent = createReactAgent({
      llm,
      tools: createHermesPlannerTools(ctx.actions, ctx.scoping),
      prompt: ctx.systemPrompt,
    });

    const human = new HumanMessage(text);
    const input = [...this.messages, human];
    const collected: BaseMessage[] = [];
    const seen = new Set<string>();
    let lastText = "";

    try {
      const stream = await agent.stream(
        { messages: input },
        { streamMode: "updates", recursionLimit: 100 },
      );

      for await (const update of stream) {
        for (const node of Object.keys(update)) {
          const msgs: BaseMessage[] =
            (update as Record<string, { messages?: BaseMessage[] }>)[node]?.messages ?? [];
          for (const m of msgs) {
            const key = (m as { id?: string }).id ?? `${node}:${contentToText(m.content)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            collected.push(m);
            for (const ev of eventsFor(m)) yield ev;
            if (m instanceof AIMessage && (m.tool_calls?.length ?? 0) === 0) {
              const t = contentToText(m.content).trim();
              if (t) lastText = t;
            }
          }
        }
      }

      // Persist the turn (human + everything the agent produced) for the next turn.
      this.messages = [...this.messages, human, ...collected];
      yield { type: "done", summary: lastText };
    } catch (err) {
      yield { type: "error", message: (err as Error).message };
    }
  }
}
