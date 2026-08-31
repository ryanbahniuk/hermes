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
  setSessionPid,
  setSessionResumeRef,
  setSessionStatus,
  setSessionTitle,
  touchSessionHeartbeat,
  type SessionRow,
} from "../db";
import { appendLog, sessionLogFile } from "../logging/logs";
import { createPlannerActions } from "./actions";
import {
  selectPlannerRuntime,
  type PlannerEvent,
  type PlannerRuntime,
  type PriorMessage,
} from "./runtime";
import { plannerScoping } from "./tools";
import { prompts } from "../prompts";

/**
 * How often the live process refreshes its heartbeat. `sessionLive` in the TUI
 * theme treats a session as dead once the heartbeat is a small multiple of this
 * stale — keep the two in step if you change this.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Compact one-line rendering of a tool input for the session log. */
function shortJSON(input: unknown): string {
  const s = typeof input === "string" ? input : JSON.stringify(input ?? {});
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** A live planning conversation bound to one persisted session + one runtime instance. */
export class PlannerSession {
  private heartbeat: ReturnType<typeof setInterval> | null = null;

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
    const session = new PlannerSession(row, model, runtime, false);
    session.goLive();
    return session;
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
    const session = new PlannerSession(row, model, runtime, Boolean(row.title));
    session.goLive();
    return session;
  }

  /**
   * Attaches this process to the session: stamps our pid, reactivates the row, and
   * starts the heartbeat. Reactivation is deliberate and status-agnostic — reopening
   * a cleanly-closed *or an archived* session by id makes it live again. Opening an
   * archived session is thus an implicit unarchive: we never leave an archived row
   * masquerading as "active", it genuinely becomes active again. (Use
   * `unarchiveSession` to restore-without-opening.) The timer is unref'd so it never
   * keeps the process alive on its own.
   */
  private goLive(): void {
    setSessionStatus(this.id, "active");
    setSessionPid(this.id, process.pid);
    touchSessionHeartbeat(this.id);
    this.heartbeat = setInterval(() => touchSessionHeartbeat(this.id), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  /** Clean exit: stops the heartbeat and marks the session closed (active→closed). */
  close(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    setSessionStatus(this.id, "closed");
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
    touchSessionHeartbeat(this.id);
    addSessionMessage({ sessionId: this.id, role: "user", content: text });
    if (!this.titled) {
      setSessionTitle(this.id, text.replace(/\s+/g, " ").slice(0, 80));
      this.titled = true;
    }

    const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let runtimeCost: number | undefined;
    const assistantParts: string[] = [];
    const logFile = sessionLogFile(this.id);
    appendLog(logFile, `you › ${text.replace(/\s+/g, " ")}`);

    for await (const ev of this.runtime.send(text)) {
      switch (ev.type) {
        case "text":
          assistantParts.push(ev.text);
          break;
        // Tool activity is dropped from the chat view; the session log is its
        // only durable home, so record every call and result here.
        case "tool_call":
          appendLog(logFile, `→ ${ev.tool}(${shortJSON(ev.input)})`);
          break;
        case "tool_result":
          appendLog(logFile, `← ${ev.ok ? "" : "ERR "}${ev.preview.replace(/\s+/g, " ")}`);
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
    if (reply) {
      addSessionMessage({ sessionId: this.id, role: "assistant", content: reply });
      appendLog(logFile, `assistant › ${reply.replace(/\s+/g, " ")}`);
    }

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
