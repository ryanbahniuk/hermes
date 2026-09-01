import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { TackConfig } from "../../config/schema";
import {
  listRunsBySession,
  listSessionPrs,
  listSessions,
  listTasks,
  sessionTotalCost,
} from "../../db";
import {
  allRunsTerminal,
  archiveSession,
  deleteSession,
  killSession,
  stopRun,
  unarchiveSession,
} from "../../sessions/actions";
import {
  actionHint,
  prLive,
  runActions,
  runLive,
  sessionActions,
  sessionLive,
  usd,
  type RowAction,
} from "./theme";
import { patchRow, withoutSessionBlock, type Row } from "./rows";

function buildRows(showArchived: boolean): Row[] {
  const rows: Row[] = [];
  for (const s of listSessions({ includeArchived: showArchived })) {
    const runs = listRunsBySession(s.id);
    rows.push({
      key: `s:${s.id}`,
      kind: "session",
      session: s,
      cost: sessionTotalCost(s.id),
      allRunsTerminal: allRunsTerminal(runs),
    });
    for (const r of runs) {
      rows.push({ key: `r:${r.id}`, kind: "run", run: r, taskCount: listTasks(r.id).length });
    }
    for (const pr of listSessionPrs(s.id)) {
      rows.push({ key: `pr:${pr.id}`, kind: "pr", pr });
    }
  }
  return rows;
}

/**
 * The destructive actions valid for a row in its current live state — the single
 * source of truth shared by the per-row hint, the footer, and the key handlers,
 * so an offered affordance can never diverge from what the key actually does.
 */
function actionsFor(row: Row): RowAction[] {
  if (row.kind === "session") return sessionActions(row.session, row.allRunsTerminal);
  if (row.kind === "run") return runActions(row.run);
  return []; // PR rows are informational — no destructive actions.
}

/**
 * Defer a blocking backend action off the render path: `setTimeout(0)` lets Ink
 * flush the optimistic row change to the terminal before the (possibly heavy)
 * teardown runs and blocks the main thread. Failures are swallowed on purpose —
 * the 500ms poll rebuilds rows from real state, so a partial/failed teardown just
 * reappears or reconciles on the next tick rather than crashing the input handler.
 */
function runInBackground(action: () => void): void {
  setTimeout(() => {
    try {
      action();
    } catch {
      // Reconciled by the next poll rebuild.
    }
  }, 0);
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
    const actions = sessionActions(s, row.allRunsTerminal);
    return (
      <Box>
        {pointer}
        <Text color={live.color} dimColor={live.dim}>●</Text>
        <Text> </Text>
        {/* The live label sits right beside its colored dot so the color always
            reads with its meaning — matching how run rows show their status. */}
        <Text color={live.color} dimColor={live.dim}>{live.label}</Text>
        <Text> </Text>
        <Text bold={selected}>{(s.title ?? "(untitled)").slice(0, 48)}</Text>
        <Text dimColor>
          {"  " + s.id + "  " + (s.planner_model ?? "-") + "  " + usd(cost.total)}
        </Text>
        {/* Only the transitions valid for this session's state are offered. */}
        {selected && actions.length > 0 && <Text color="yellow">{"  " + actionHint(actions)}</Text>}
      </Box>
    );
  }

  if (row.kind === "pr") {
    const { pr } = row;
    const live = prLive(pr);
    const num = pr.number != null ? `#${pr.number}` : pr.url;
    return (
      <Box>
        {pointer}
        <Text>{"  "}</Text>
        <Text color={live.color} dimColor={live.dim}>
          {live.label.padEnd(8)}
        </Text>
        <Text dimColor>
          {num + (pr.project_name ? "  " + pr.project_name : "") + "  " + (pr.title ?? pr.url).slice(0, 40)}
        </Text>
      </Box>
    );
  }

  const live = runLive(row.run);
  const actions = runActions(row.run);
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
      {/* A terminal run offers nothing; a live/stalled one can be stopped. */}
      {selected && actions.length > 0 && <Text color="yellow">{"  " + actionHint(actions)}</Text>}
    </Box>
  );
}

export interface DashboardProps {
  /** Loaded config — the project name→repo map delete needs to purge worktrees. */
  config: TackConfig;
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
 * a session into its chat, a run into its read-only log. Destructive actions fire
 * immediately on the highlighted row (no confirmation): `x` kills a session or
 * stops a run, `a` archives a finished session (all runs terminal), `u` unarchives
 * a revealed archived session, `d` permanently deletes a session. Archived sessions
 * are hidden by default; `z` toggles them into/out of the tree.
 */
export function Dashboard({
  config,
  onOpenSession,
  onOpenRun,
  onNewSession,
  onQuit,
}: DashboardProps): React.ReactElement {
  // Archived sessions are soft-hidden; `z` reveals them (getSession by id still
  // works regardless). The build + poll below key off this so toggling is live.
  const [showArchived, setShowArchived] = useState(false);
  const [rows, setRows] = useState<Row[]>(() => buildRows(false));
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    const tick = () => setRows(buildRows(showArchived));
    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [showArchived]);

  // Keep the cursor in range as rows appear and disappear under it.
  const max = Math.max(0, rows.length - 1);
  const active = Math.min(cursor, max);
  const activeRow = rows[active];

  useInput((input, key) => {
    if (input === "q") return void onQuit();
    if (input === "n") return void onNewSession();
    // Reveal/hide archived sessions — a view toggle, not a row action.
    if (input === "z") return void setShowArchived((v) => !v);
    if (key.upArrow || input === "k") return void setCursor((c) => Math.max(0, Math.min(c, max) - 1));
    if (key.downArrow || input === "j") return void setCursor((c) => Math.min(max, Math.min(c, max) + 1));
    if (key.return) {
      const row = rows[active];
      if (!row) return;
      if (row.kind === "session") onOpenSession(row.session.id);
      else if (row.kind === "run") onOpenRun(row.run.id);
      // PR rows are informational — Enter does nothing (no read-only view yet).
      return;
    }
    // Destructive actions update the highlighted row optimistically — the visible
    // rows (and cursor clamp) change on this keypress, before the blocking backend
    // action runs off the render path — so the repaint never waits on teardown. The
    // 500ms poll rebuild stays the source of truth and reconciles any partial/failed
    // teardown on its next tick.
    if (input === "x") {
      const row = rows[active];
      if (!row) return;
      // Inert unless stop/kill is a valid transition for this row's live state —
      // e.g. `x` on a terminal run or a non-active session does nothing.
      if (!actionsFor(row).some((a) => a.key === "x")) return;
      if (row.kind === "session") {
        // Kill settles to "closed": the row stays but drops its "kill" affordance.
        setRows((rs) => patchRow(rs, active, { ...row, session: { ...row.session, status: "closed" } }));
        const id = row.session.id;
        runInBackground(() => killSession(id));
      } else if (row.kind === "run") {
        // Stop settles the run terminal: reads "stopped" and offers nothing further.
        setRows((rs) =>
          patchRow(rs, active, { ...row, run: { ...row.run, status: "stopped", supervisor_pid: null } }),
        );
        const runRow = row.run;
        runInBackground(() => stopRun(runRow));
      }
      return;
    }
    if (input === "a") {
      const row = rows[active];
      // Archive is session-only, and only when offered (all runs terminal, not
      // already archived) — inert otherwise, so a stray `a` can't force it.
      if (!row || row.kind !== "session") return;
      if (!actionsFor(row).some((x) => x.key === "a")) return;
      const id = row.session.id;
      // While archived sessions are hidden, archiving removes the block; when they
      // are revealed the row stays and simply re-reads as "archived".
      if (showArchived) {
        setRows((rs) => patchRow(rs, active, { ...row, session: { ...row.session, status: "archived" } }));
      } else {
        setRows((rs) => withoutSessionBlock(rs, active));
        setCursor((c) => Math.max(0, Math.min(c, rows.length - 2)));
      }
      runInBackground(() => archiveSession(id));
      return;
    }
    if (input === "u") {
      const row = rows[active];
      // Unarchive only applies to a revealed archived session.
      if (!row || row.kind !== "session") return;
      if (!actionsFor(row).some((x) => x.key === "u")) return;
      const id = row.session.id;
      // The revealed row stays put and flips from "archived" back to "closed".
      setRows((rs) => patchRow(rs, active, { ...row, session: { ...row.session, status: "closed" } }));
      runInBackground(() => unarchiveSession(id));
      return;
    }
    if (input === "d") {
      const row = rows[active];
      // Delete is session-only — a run row has no delete action.
      if (!row || row.kind !== "session") return;
      const id = row.session.id;
      // Drop the whole session block immediately; the heavy teardown (stop runs →
      // purge worktrees/branches → remove logs → delete rows) runs in the background.
      setRows((rs) => withoutSessionBlock(rs, active));
      setCursor((c) => Math.max(0, Math.min(c, rows.length - 2)));
      runInBackground(() => deleteSession(id, config));
      return;
    }
  });

  // The footer help is derived from the highlighted row's actual available
  // actions (same source as the per-row hint), so it never advertises a verb the
  // key handler would ignore. A terminal run contributes no destructive verbs.
  const actionHelp = activeRow ? actionHint(actionsFor(activeRow)) : "";
  const footer = [
    "↑/↓ move",
    "Enter open",
    "n new session",
    ...(actionHelp ? [actionHelp] : []),
    `z ${showArchived ? "hide" : "show"} archived`,
    "q quit",
  ].join(" · ");

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
        <Text dimColor>{footer}</Text>
      </Box>
    </Box>
  );
}
