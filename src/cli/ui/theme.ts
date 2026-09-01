import type { RunRow, SessionPrRow, SessionRow } from "../../db";
import { isAlive } from "../../process/spawn";

/** A status rendered as a colored label — the shared vocabulary of the TUIs. */
export interface Live {
  label: string;
  color: string;
  /** Render dimmed (terminal states that are no longer moving). */
  dim: boolean;
}

/** Maps a run/task lifecycle status to a color. */
export function statusColor(status: string): string {
  switch (status) {
    case "done":
      return "green";
    case "failed":
      return "red";
    // A user-initiated stop is terminal but not a failure — blue sets it apart
    // from failed=red, done=green, and stalled/dead=yellow.
    case "stopped":
      return "blue";
    case "stalled":
      return "yellow";
    case "pending":
      return "gray";
    default:
      return "cyan";
  }
}

/**
 * A run's *live* status: terminal runs report their stored status; in-flight
 * runs are "running" only while their supervisor pid is alive, else "stalled".
 * This is the single source of truth shared by the dashboard and the chat view.
 */
export function runLive(r: RunRow): Live {
  const terminal = r.status === "done" || r.status === "failed" || r.status === "stopped";
  if (terminal) {
    return { label: r.status, color: statusColor(r.status), dim: true };
  }
  return isAlive(r.supervisor_pid)
    ? { label: "running", color: "green", dim: false }
    : { label: "stalled", color: "yellow", dim: false };
}

/**
 * A session is dead if its heartbeat hasn't ticked within this window. It's a
 * few multiples of the planner's ~15s HEARTBEAT_INTERVAL_MS (see PlannerSession),
 * so a couple of missed beats — a busy turn, GC pause — don't flash "dead".
 */
const SESSION_STALE_MS = 60_000;

/**
 * A session's *live* status, mirroring `runLive` for sessions. An archived session
 * reports "archived"; otherwise it's "active" only while its recorded pid is alive
 * AND its heartbeat is fresh. A session whose interactive process cleanly exited,
 * was killed, or crashed reads "dead" — no longer masquerading as active.
 */
export function sessionLive(s: SessionRow): Live {
  // Archived is a soft-hidden, finished state, so it reads gray+dim with its own label.
  if (s.status === "archived") {
    return { label: "archived", color: "gray", dim: true };
  }
  const fresh =
    s.heartbeat_at != null && Date.now() - Date.parse(s.heartbeat_at) < SESSION_STALE_MS;
  return isAlive(s.pid) && fresh
    ? { label: "active", color: "green", dim: false }
    : { label: "dead", color: "yellow", dim: false };
}

/**
 * A PR's status as a colored label, mirroring `runLive`/`sessionLive` so PRs read
 * with the same vocabulary in the dashboard and the chat view. States are stored
 * lowercased (see `src/projects/prs.ts`): open reads green (live), merged magenta
 * (GitHub's color, dimmed as it's terminal), closed red+dim; anything else gray.
 */
export function prLive(pr: SessionPrRow): Live {
  switch (pr.state) {
    case "open":
      return { label: "open", color: "green", dim: false };
    case "merged":
      return { label: "merged", color: "magenta", dim: true };
    case "closed":
      return { label: "closed", color: "red", dim: true };
    default:
      return { label: pr.state ?? "unknown", color: "gray", dim: true };
  }
}

/** A destructive action offered on a dashboard row: its key and hint verb. */
export interface RowAction {
  /** The keybinding that fires it. */
  key: "x" | "d" | "a" | "u";
  /** The verb shown next to the key, e.g. "stop", "kill", "delete", "archive". */
  hint: string;
}

/**
 * The destructive actions valid for a run *in its current live state* — the
 * single source of truth behind the per-row hint, the footer, and the key
 * handler. A run can only be stopped while it's still in flight (running or
 * stalled); a terminal run (done/failed/stopped) offers nothing.
 */
export function runActions(r: RunRow): RowAction[] {
  const { label } = runLive(r);
  const terminal = label === "done" || label === "failed" || label === "stopped";
  return terminal ? [] : [{ key: "x", hint: "stop" }];
}

/**
 * The destructive actions valid for a session *in its current live state*. Kill
 * only makes sense on an active session (a dead one has nothing live to
 * signal); archive is offered only when every run is terminal (`allRunsTerminal`,
 * threaded in by the caller — the same gate {@link archiveSession} enforces, so
 * the offered affordance can't diverge from what the action allows); an already-
 * archived session offers only unarchive (recover it); delete is always available.
 */
export function sessionActions(s: SessionRow, allRunsTerminal: boolean): RowAction[] {
  const actions: RowAction[] = [];
  if (s.status === "archived") {
    // A revealed archived session is finished + hidden: recover it or delete it.
    actions.push({ key: "u", hint: "unarchive" });
    actions.push({ key: "d", hint: "delete" });
    return actions;
  }
  if (sessionLive(s).label === "active") actions.push({ key: "x", hint: "kill" });
  if (allRunsTerminal) actions.push({ key: "a", hint: "archive" });
  actions.push({ key: "d", hint: "delete" });
  return actions;
}

/** Renders a row's actions as a hint string, e.g. `x kill · d delete`. */
export function actionHint(actions: RowAction[]): string {
  return actions.map((a) => `${a.key} ${a.hint}`).join(" · ");
}

/** A short USD string, e.g. `$0.0421`. */
export function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}
