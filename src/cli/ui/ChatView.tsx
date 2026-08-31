import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  listRunsBySession,
  listSessionPrs,
  sessionTotalCost,
  type RunRow,
  type SessionCost,
  type SessionPrRow,
} from "../../db";
import type { PlannerEvent } from "../../planner/runtime";
import type { PlannerSession } from "../../planner/session";
import { Horse } from "./Horse";
import { Prompt } from "./Prompt";
import { prLive, runLive, usd } from "./theme";
import { createTurnQueue, type TurnQueue } from "./turnQueue";
import { useTerminalSize } from "./useTerminalSize";

// ---- transcript model -----------------------------------------------------

type Line =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "error"; message: string }
  | { id: string; kind: "notice"; text: string }
  | { id: string; kind: "cost"; cost: SessionCost }
  | { id: string; kind: "runs"; runs: RunRow[] }
  | { id: string; kind: "prs"; prs: SessionPrRow[] };

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
    case "prs":
      if (line.prs.length === 0) return <Text dimColor>{"  (no PRs opened yet)"}</Text>;
      return (
        <Box flexDirection="column">
          {line.prs.map((pr) => {
            const live = prLive(pr);
            const num = pr.number != null ? `#${pr.number}` : pr.url;
            return (
              <Text key={pr.id}>
                {"  "}
                <Text color={live.color} dimColor={live.dim}>
                  {live.label.padEnd(6)}
                </Text>{" "}
                <Text bold>{num}</Text>{" "}
                {pr.project_name && <Text dimColor>{pr.project_name + "  "}</Text>}
                <Text dimColor>{(pr.title ?? pr.url).slice(0, 60)}</Text>
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
  "    /prs      list PRs opened by this session",
  "    /help     show this help",
  "    /exit     leave the session (it's saved; resume any time)",
];

function eventToLine(ev: PlannerEvent, id: string): Line | null {
  switch (ev.type) {
    case "text": {
      const t = ev.text.trim();
      return t ? { id, kind: "assistant", text: t } : null;
    }
    // Tool calls/results are intentionally omitted from the chat view — they are
    // recorded in the session log instead (see PlannerSession.sendTurn).
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
 * The interactive planning conversation, rendered fullscreen in the alternate
 * screen buffer. The horse + its ground (grass) are pinned to the very bottom of
 * the viewport; the transcript scrolls INTERNALLY in the space above them and can
 * never grow down far enough to overlap the horse. This trades the terminal's
 * native scrollback for a self-contained, always-visible horse — a deliberate
 * choice. The transcript auto-follows the newest output by default, and PgUp/
 * PgDn or ↑/↓ scroll back through history (anchored by line id so streaming
 * output doesn't yank the view).
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
  const { columns, rows } = useTerminalSize();

  // Scroll-back state. `anchor` is the id of the transcript line pinned to the
  // bottom of the viewport; `null` means "follow" — stay pinned to the latest
  // output. Anchoring by line id (not offset) keeps the view still while new
  // lines stream in below. `scrollRef` gives the key handler the current
  // transcript + layout without re-subscribing useInput every render.
  const [anchor, setAnchor] = useState<string | null>(null);
  const scrollRef = useRef<{ ids: string[]; page: number }>({ ids: [], page: 1 });

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

  // Scroll keys are handled here rather than in the always-active Prompt so they
  // never leak into the input buffer. Only non-printable keys are used (Prompt
  // types every printable character), so PgUp/PgDn and ↑/↓ are safe.
  useInput((_input, key) => {
    if (key.escape && !busy) return void onExit();

    const { ids, page } = scrollRef.current;
    const len = ids.length;
    if (len === 0) return;

    // Move the pinned-bottom line by `delta` lines (negative = scroll up toward
    // older output). Landing on the last line resumes follow mode (anchor null).
    const scrollBy = (delta: number) => {
      setAnchor((cur) => {
        const bottom = cur === null ? len - 1 : Math.max(0, ids.indexOf(cur));
        const next = Math.min(len - 1, Math.max(0, bottom + delta));
        return next >= len - 1 ? null : ids[next];
      });
    };

    if (key.pageUp) return scrollBy(-page);
    if (key.pageDown) return scrollBy(page);
    if (key.upArrow) return scrollBy(-1);
    if (key.downArrow) return scrollBy(1);
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

    // Any submission snaps the transcript back to the latest output.
    setAnchor(null);

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
    if (text === "/prs") {
      append(
        { id: nextId(), kind: "user", text },
        { id: nextId(), kind: "prs", prs: listSessionPrs(session.id) },
      );
      return;
    }

    // Everything else becomes a planner turn: enqueue and let the queue drain.
    queueRef.current!.submit(text);
  }

  const footer = embedded
    ? `Esc back · PgUp/PgDn scroll · /runs /prs /help /exit · ${usd(cost.total)}`
    : `/runs · /prs · /help · /exit · PgUp/PgDn scroll · Ctrl-C to quit · ${usd(cost.total)}`;

  // Transcript = committed history + the in-flight turn, as one scroll stream.
  // Follow mode (anchor === null) pins to the newest line; when scrolled up,
  // `anchor` is the id of the line held at the bottom edge, and `newerBelow`
  // reveals how much output is hidden below the fold. Anchoring by line id keeps
  // the view still while new lines stream in during a turn.
  const transcript = [...committed, ...live];
  const len = transcript.length;
  const anchorIdx = anchor === null ? -1 : transcript.findIndex((l) => l.id === anchor);
  const endIdx = anchorIdx >= 0 ? anchorIdx + 1 : len; // exclusive slice bound
  const newerBelow = endIdx < len;

  // Only render the tail that could be visible; the scroll region below clips
  // the rest via flexbox (overflow hidden + flex-end), which bounds layout work
  // on long sessions. The window ends at the anchor (or the latest line).
  const windowSize = Math.max(rows, 40);
  const visible = transcript.slice(Math.max(0, endIdx - windowSize), endIdx);
  const separator = "─".repeat(Math.max(0, columns));

  // Hand the key handler the current line ids and paging math.
  scrollRef.current = { ids: transcript.map((l) => l.id), page: Math.max(1, rows - 4) };

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      {/* Transcript scroll region: fills the space above the pinned horse. It
          pins its content to the bottom (justifyContent flex-end) and hides the
          overflow, so the newest lines stay in view and the oldest scroll off
          the top — the horse below is never pushed off-screen. When scrolled
          back, the window ends at the anchor line instead of the latest. */}
      <Box flexGrow={1} flexDirection="column" overflow="hidden" justifyContent="flex-end">
        {visible.map((line) => (
          <LineView key={line.id} line={line} />
        ))}
      </Box>

      {/* The pinned bottom region: a full-width rule separates it from the chat,
          then the prompt/footer sit just above the horse, which grazes on its
          full-width grass at the very bottom of the viewport. */}
      <Box flexShrink={0} flexDirection="column">
        <Text dimColor>{separator}</Text>
        {newerBelow && (
          <Text dimColor>{`  ⋯ ${len - endIdx} newer line(s) below · PgDn/↓ to catch up`}</Text>
        )}
        {queued.length > 0 &&
          queued.map((text, i) => (
            <Text key={i} dimColor>
              {"  queued: " + text}
            </Text>
          ))}
        <Prompt onSubmit={handleSubmit} isActive placeholder="ask the planner…" />
        <Text dimColor>{footer}</Text>
        <Horse running={workersRunning} />
      </Box>
    </Box>
  );
}
