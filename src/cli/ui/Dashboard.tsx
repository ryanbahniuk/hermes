import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  listRunsBySession,
  listSessions,
  listTasks,
  sessionTotalCost,
  type RunRow,
  type SessionCost,
  type SessionRow,
} from "../../db";
import { runLive, sessionLive, usd } from "./theme";

// A dashboard row is either a session header or one of its runs, flattened into
// a single navigable list so a single cursor can walk the whole tree.
type Row =
  | { key: string; kind: "session"; session: SessionRow; cost: SessionCost }
  | { key: string; kind: "run"; run: RunRow; taskCount: number };

function buildRows(): Row[] {
  const rows: Row[] = [];
  for (const s of listSessions()) {
    rows.push({ key: `s:${s.id}`, kind: "session", session: s, cost: sessionTotalCost(s.id) });
    for (const r of listRunsBySession(s.id)) {
      rows.push({ key: `r:${r.id}`, kind: "run", run: r, taskCount: listTasks(r.id).length });
    }
  }
  return rows;
}

function RowView({ row, selected }: { row: Row; selected: boolean }): React.ReactElement {
  const pointer = selected ? (
    <Text color="cyan" bold>
      ▸{" "}
    </Text>
  ) : (
    <Text>{"  "}</Text>
  );

  if (row.kind === "session") {
    const { session: s, cost } = row;
    const live = sessionLive(s);
    return (
      <Box>
        {pointer}
        <Text color={live.color} dimColor={live.dim}>●</Text>
        <Text> </Text>
        <Text bold={selected}>{(s.title ?? "(untitled)").slice(0, 48)}</Text>
        <Text dimColor>
          {"  " + s.id + "  " + live.label + "  " + (s.planner_model ?? "-") + "  " + usd(cost.total)}
        </Text>
      </Box>
    );
  }

  const live = runLive(row.run);
  return (
    <Box>
      {pointer}
      <Text>{"  "}</Text>
      <Text color={live.color} dimColor={live.dim}>
        {live.label.padEnd(8)}
      </Text>
      <Text dimColor>
        {row.run.id + "  " + `${row.taskCount} task${row.taskCount === 1 ? "" : "s"}` + "  " + usd(row.run.cost)}
      </Text>
      <Text dimColor>{"  " + row.run.problem.slice(0, 40)}</Text>
    </Box>
  );
}

export interface DashboardProps {
  /** Open the interactive chat for a session (Enter on a session row). */
  onOpenSession: (sessionId: string) => void;
  /** Open the read-only log for a run (Enter on a run row). */
  onOpenRun: (runId: string) => void;
  /** Start a fresh planning session and drop into its chat (n). */
  onNewSession: () => void;
  /** Quit the whole app (q). */
  onQuit: () => void;
}

/**
 * The `stable` dashboard: every session and its dispatched runs in one live,
 * navigable tree. Arrow keys move the cursor; Enter opens the highlighted row —
 * a session into its chat, a run into its read-only log.
 */
export function Dashboard({ onOpenSession, onOpenRun, onNewSession, onQuit }: DashboardProps): React.ReactElement {
  const [rows, setRows] = useState<Row[]>(() => buildRows());
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    const tick = () => setRows(buildRows());
    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, []);

  // Keep the cursor in range as rows appear and disappear under it.
  const max = Math.max(0, rows.length - 1);
  const active = Math.min(cursor, max);

  useInput((input, key) => {
    if (input === "q") return void onQuit();
    if (input === "n") return void onNewSession();
    if (key.upArrow || input === "k") return void setCursor((c) => Math.max(0, Math.min(c, max) - 1));
    if (key.downArrow || input === "j") return void setCursor((c) => Math.min(max, Math.min(c, max) + 1));
    if (key.return) {
      const row = rows[active];
      if (!row) return;
      if (row.kind === "session") onOpenSession(row.session.id);
      else onOpenRun(row.run.id);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Tack — stable</Text>
      <Text dimColor>every session and its runs · live</Text>

      <Box marginTop={1} flexDirection="column">
        {rows.length === 0 && (
          <Text dimColor>No sessions yet. Press `n` to start one (or run `tack session start`).</Text>
        )}
        {rows.map((row, i) => (
          <RowView key={row.key} row={row} selected={i === active} />
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · Enter open · n new session · q quit</Text>
      </Box>
    </Box>
  );
}
