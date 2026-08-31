import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import { listRunsBySession, sessionTotalCost, type RunRow, type SessionCost } from "../../db";
import type { PlannerEvent } from "../../planner/runtime";
import type { PlannerSession } from "../../planner/session";
import { Horse } from "./Horse";
import { Prompt } from "./Prompt";
import { runLive, usd } from "./theme";
import { createTurnQueue, type TurnQueue } from "./turnQueue";

// ---- transcript model -----------------------------------------------------

type Line =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "tool_call"; tool: string; input: string }
  | { id: string; kind: "tool_result"; ok: boolean; preview: string }
  | { id: string; kind: "error"; message: string }
  | { id: string; kind: "notice"; text: string }
  | { id: string; kind: "cost"; cost: SessionCost }
  | { id: string; kind: "runs"; runs: RunRow[] };

function shortJSON(input: unknown): string {
  const s = typeof input === "string" ? input : JSON.stringify(input ?? {});
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** One transcript line. Kept dumb: every visual decision lives here. */
function LineView({ line }: { line: Line }): React.ReactElement | null {
  switch (line.kind) {
    case "user":
      return (
        <Text>
          <Text color="cyan">you › </Text>
          {line.text}
        </Text>
      );
    case "assistant":
      return <Text>{line.text}</Text>;
    case "tool_call":
      return (
        <Text dimColor>
          {"  → "}
          {line.tool}({line.input})
        </Text>
      );
    case "tool_result":
      return (
        <Text dimColor>
          {"  ← "}
          {line.ok ? "" : "ERR "}
          {line.preview.replace(/\s+/g, " ")}
        </Text>
      );
    case "error":
      return <Text color="red">{"  error: " + line.message}</Text>;
    case "notice":
      return <Text dimColor>{line.text}</Text>;
    case "cost":
      return (
        <Text dimColor>
          {"  ── session cost "}
          {usd(line.cost.total)} (planning {usd(line.cost.planner)} + work {usd(line.cost.work)})
        </Text>
      );
    case "runs":
      if (line.runs.length === 0) return <Text dimColor>{"  (no runs dispatched yet)"}</Text>;
      return (
        <Box flexDirection="column">
          {line.runs.map((r) => {
            const live = runLive(r);
            return (
              <Text key={r.id}>
                {"  "}
                <Text bold>{r.id}</Text> <Text color={live.color} dimColor={live.dim}>
                  {live.label}
                </Text>{" "}
                <Text dimColor>{usd(r.cost)}</Text> <Text dimColor>{r.problem.slice(0, 60)}</Text>
              </Text>
            );
          })}
        </Box>
      );
  }
}

const HELP: string[] = [
  "  Commands:",
  "    /runs     list runs dispatched from this session",
  "    /help     show this help",
  "    /exit     leave the session (it's saved; resume any time)",
];

function eventToLine(ev: PlannerEvent, id: string): Line | null {
  switch (ev.type) {
    case "text": {
      const t = ev.text.trim();
      return t ? { id, kind: "assistant", text: t } : null;
    }
    case "tool_call":
      return { id, kind: "tool_call", tool: ev.tool, input: shortJSON(ev.input) };
    case "tool_result":
      return { id, kind: "tool_result", ok: ev.ok, preview: ev.preview };
    case "error":
      return { id, kind: "error", message: ev.message };
    default:
      return null;
  }
}

// ---- view ------------------------------------------------------------------

export interface ChatViewProps {
  session: PlannerSession;
  /** Called on /exit, /quit, or Esc. Owner decides: quit app or pop a view. */
  onExit: () => void;
  /** Resume transcript to seed the scrollback (from `session.history()`). */
  history?: { role: "user" | "assistant"; content: string }[];
  /** True when hosted inside `stable` (changes the footer hint). */
  embedded?: boolean;
}

/**
 * The interactive planning conversation. The committed transcript scrolls in an
 * Ink `<Static>` region (written once, never redrawn); the in-flight turn, the
 * galloping-horse spinner, and the input line live in the dynamic region below.
 */
export function ChatView({ session, onExit, history = [], embedded = false }: ChatViewProps): React.ReactElement {
  const idRef = useRef(0);
  const nextId = () => `l${idRef.current++}`;

  const initial = useMemo<Line[]>(() => {
    const lines: Line[] = [];
    lines.push({
      id: nextId(),
      kind: "notice",
      text: `Tack planning session ${session.id}  (${session.model.name}@${session.model.version}, runtime=${session.model.runtime})`,
    });
    if (history.length > 0) {
      lines.push({ id: nextId(), kind: "notice", text: `  resuming — ${history.length} prior message(s)` });
      for (const m of history) {
        lines.push(
          m.role === "user"
            ? { id: nextId(), kind: "user", text: m.content.trim() }
            : { id: nextId(), kind: "assistant", text: m.content.trim() },
        );
      }
    }
    lines.push({
      id: nextId(),
      kind: "notice",
      text: "  Talk to the planner. It clarifies, then delegates to worker agents. /help for commands.",
    });
    return lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [committed, setCommitted] = useState<Line[]>(initial);
  const [live, setLive] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<string[]>([]);
  const [cost, setCost] = useState<SessionCost>(() => sessionTotalCost(session.id));
  const [workersRunning, setWorkersRunning] = useState(false);

  // Background worker runs mutate the DB out of band, so the gallop can't be
  // driven off local turn state — it must reflect whether any dispatched run is
  // still live. Poll the runs table and re-render as runs start and finish.
  useEffect(() => {
    const check = () => {
      const active = listRunsBySession(session.id).some(
        (r) => r.status !== "done" && r.status !== "failed" && r.status !== "stopped",
      );
      setWorkersRunning(active);
    };
    check();
    const timer = setInterval(check, 1000);
    return () => clearInterval(timer);
  }, [session.id]);

  useInput((_input, key) => {
    if (key.escape && !busy) onExit();
  });

  const append = (...lines: Line[]) => setCommitted((prev) => [...prev, ...lines]);

  // Run exactly one planner turn to completion. Kept in a ref so the queue's
  // drain loop always calls the latest closure (fresh `session`/setters) rather
  // than a stale one captured at queue-creation time.
  const runTurnRef = useRef<(text: string) => Promise<void>>(async () => {});
  runTurnRef.current = async (text: string) => {
    // The user line lands in the transcript only when the turn actually starts,
    // so queued-but-unsent messages stay in the dim "queued" list until then.
    append({ id: nextId(), kind: "user", text });
    setBusy(true);
    const buffer: Line[] = [];
    try {
      await session.sendTurn(text, (ev) => {
        const line = eventToLine(ev, nextId());
        if (line) {
          buffer.push(line);
          setLive([...buffer]);
        }
      });
    } catch (err) {
      buffer.push({ id: nextId(), kind: "error", message: (err as Error).message });
    } finally {
      const c = sessionTotalCost(session.id);
      setCommitted((prev) => [...prev, ...buffer, { id: nextId(), kind: "cost", cost: c }]);
      setLive([]);
      setCost(c);
      setBusy(false);
    }
  };

  // One queue for the lifetime of the view: it serializes turns (never two at
  // once) and auto-drains any messages submitted while a turn was in flight.
  const queueRef = useRef<TurnQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = createTurnQueue({
      runTurn: (text) => runTurnRef.current(text),
      onChange: setQueued,
    });
  }

  function handleSubmit(raw: string): void {
    const text = raw.trim();
    if (!text) return;

    // Local, read-only slash commands are handled inline and must fire
    // immediately — even mid-turn — so they are never queued.
    if (text === "/exit" || text === "/quit") return void onExit();
    if (text === "/help") {
      append(...HELP.map((t) => ({ id: nextId(), kind: "notice" as const, text: t })));
      return;
    }
    if (text === "/runs") {
      append(
        { id: nextId(), kind: "user", text },
        { id: nextId(), kind: "runs", runs: listRunsBySession(session.id) },
      );
      return;
    }

    // Everything else becomes a planner turn: enqueue and let the queue drain.
    queueRef.current!.submit(text);
  }

  const footer = embedded
    ? `Esc back to dashboard · /runs /help /exit · ${usd(cost.total)}`
    : `/runs · /help · /exit · Ctrl-C to quit · ${usd(cost.total)}`;

  return (
    <Box flexDirection="column">
      <Static items={committed}>{(line) => <LineView key={line.id} line={line} />}</Static>

      <Box flexDirection="column">
        {live.map((line) => (
          <LineView key={line.id} line={line} />
        ))}
        <Box marginTop={live.length > 0 ? 1 : 0}>
          <Horse running={workersRunning} />
        </Box>
        {queued.length > 0 && (
          <Box flexDirection="column">
            {queued.map((text, i) => (
              <Text key={i} dimColor>
                {"  queued: " + text}
              </Text>
            ))}
          </Box>
        )}
        <Prompt onSubmit={handleSubmit} isActive placeholder="ask the planner…" />
        <Box marginTop={1}>
          <Text dimColor>{footer}</Text>
        </Box>
      </Box>
    </Box>
  );
}
