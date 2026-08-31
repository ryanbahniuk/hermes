import type { TackConfig } from "../config/schema";
import { resolveModel, type ResolvedModel } from "../models/registry";
import { effectiveModelRef } from "../models/routing";
import { costFromPricing, type TokenTotals } from "../orchestrator/execute";
import {
  addSessionCost,
  addSessionMessage,
  createSession,
  getSession,
  listSessionMessages,
  setSessionResumeRef,
  setSessionTitle,
  type SessionRow,
} from "../db";
import { createPlannerActions } from "./actions";
import {
  selectPlannerRuntime,
  type PlannerEvent,
  type PlannerRuntime,
  type PriorMessage,
} from "./runtime";
import { plannerScoping } from "./tools";
import { prompts } from "../prompts";

/** A live planning conversation bound to one persisted session + one runtime instance. */
export class PlannerSession {
  private constructor(
    readonly row: SessionRow,
    readonly model: ResolvedModel,
    private readonly runtime: PlannerRuntime,
    private titled: boolean,
  ) {}

  get id(): string {
    return this.row.id;
  }

  /** Starts a fresh session with the given (or default) planner model. */
  static start(config: TackConfig, modelRef?: string): PlannerSession {
    const ref = modelRef ?? effectiveModelRef(config, "planner");
    if (!ref) throw new Error("No model given and no defaults.plannerModel configured.");
    const model = resolveModel(config, ref);

    const row = createSession({ plannerModel: ref, runtime: model.runtime });
    const runtime = buildRuntime(config, row.id, ref, model, undefined, undefined);
    return new PlannerSession(row, model, runtime, false);
  }

  /** Reopens an existing session, rehydrating conversation state for its runtime. */
  static open(config: TackConfig, sessionId: string): PlannerSession {
    const row = getSession(sessionId);
    if (!row) throw new Error(`No such session: ${sessionId}`);
    const ref = row.planner_model;
    if (!ref) throw new Error(`session ${sessionId} has no planner model`);
    const model = resolveModel(config, ref);

    const history: PriorMessage[] = listSessionMessages(sessionId).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const runtime = buildRuntime(config, sessionId, ref, model, row.resume_ref ?? undefined, history);
    return new PlannerSession(row, model, runtime, Boolean(row.title));
  }

  /** The stored transcript, for replaying to the terminal on resume. */
  history(): PriorMessage[] {
    return listSessionMessages(this.id).map((m) => ({ role: m.role, content: m.content }));
  }

  /**
   * Runs one user turn. Persists the user message and the assistant's reply,
   * captures the resume handle, rolls up cost, and forwards every event to `onEvent`.
   */
  async sendTurn(text: string, onEvent: (ev: PlannerEvent) => void): Promise<void> {
    addSessionMessage({ sessionId: this.id, role: "user", content: text });
    if (!this.titled) {
      setSessionTitle(this.id, text.replace(/\s+/g, " ").slice(0, 80));
      this.titled = true;
    }

    const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let runtimeCost: number | undefined;
    const assistantParts: string[] = [];

    for await (const ev of this.runtime.send(text)) {
      switch (ev.type) {
        case "text":
          assistantParts.push(ev.text);
          break;
        case "usage":
          tokens.input += ev.inputTokens;
          tokens.output += ev.outputTokens;
          tokens.cacheRead += ev.cacheReadTokens;
          tokens.cacheWrite += ev.cacheWriteTokens;
          break;
        case "cost":
          runtimeCost = ev.usd;
          break;
        case "session":
          setSessionResumeRef(this.id, ev.ref);
          break;
      }
      onEvent(ev);
    }

    const reply = assistantParts.join("\n").trim();
    if (reply) addSessionMessage({ sessionId: this.id, role: "assistant", content: reply });

    // Cost: claude reports it directly; tack derives it from tokens + pricing.
    const delta =
      runtimeCost !== undefined ? runtimeCost : this.model.pricing ? costFromPricing(this.model.pricing, tokens) : 0;
    if (delta > 0) addSessionCost(this.id, delta);
  }
}

function buildRuntime(
  config: TackConfig,
  sessionId: string,
  plannerRef: string,
  model: ResolvedModel,
  resumeRef: string | undefined,
  history: PriorMessage[] | undefined,
): PlannerRuntime {
  const actions = createPlannerActions(config, sessionId, plannerRef);
  return selectPlannerRuntime({
    model,
    systemPrompt: prompts.plannerSession,
    actions,
    scoping: plannerScoping(config),
    resumeRef,
    history,
  });
}
